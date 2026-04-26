// Pure routing engine. `loadConfig` is the only function that touches the
// filesystem; `decide` is a deterministic function over its inputs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEFAULT_ROUTING_CONFIG } from "./routing.config-default.js";
import type { RoutingConfig, RoutingRule } from "./types/schema.js";

export class RoutingLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RoutingLoadError";
  }
}

export interface RoutingLoadWarning {
  ruleId: string | null;
  message: string;
}

export interface CompiledRule extends RoutingRule {
  regex: RegExp;
}

export interface CompiledRoutingConfig {
  schemaVersion: 1;
  rules: CompiledRule[];
  default: RoutingConfig["default"];
  approvalRequired: string[];
  approvalRequiredCapabilities: string[];
}

export interface LoadConfigResult {
  config: CompiledRoutingConfig;
  warnings: RoutingLoadWarning[];
}

export interface LoadConfigOptions {
  /** Override config path. Default: `OPENCLAW_ORCHESTRATOR_ROUTING_PATH` env or `~/.openclaw/extensions/orchestrator/routing.json`. */
  path?: string;
  /** Override agents root for `default.agent`/`rule.agent` existence checks. Default `~/.openclaw/agents`. */
  agentsDir?: string;
  /** Skip on-disk agent-existence checks (for unit tests). */
  skipAgentValidation?: boolean;
}

export interface RoutingDecision {
  matchedRuleId: string | null;
  assignedAgentId: string;
  capabilityMatches: string[];
  fallbackUsed: boolean;
}

export function defaultRoutingConfigPath(): string {
  const fromEnv = process.env.OPENCLAW_ORCHESTRATOR_ROUTING_PATH;
  if (fromEnv != null && fromEnv.trim() !== "") {
    return resolve(fromEnv);
  }
  return resolve(homedir(), ".openclaw", "extensions", "orchestrator", "routing.json");
}

function defaultAgentsDir(): string {
  return resolve(homedir(), ".openclaw", "agents");
}

function ensureFileExists(path: string): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(DEFAULT_ROUTING_CONFIG, null, 2)}\n`);
}

function compileRule(rule: RoutingRule, warnings: RoutingLoadWarning[]): CompiledRule | null {
  try {
    return { ...rule, regex: new RegExp(rule.pattern, "i") };
  } catch (err) {
    warnings.push({
      ruleId: rule.id,
      message: `invalid regex (${(err as Error).message}); rule skipped`,
    });
    return null;
  }
}

function agentExists(agentsDir: string, agentId: string): boolean {
  return existsSync(resolve(agentsDir, agentId));
}

export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const path = options.path ?? defaultRoutingConfigPath();
  ensureFileExists(path);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new RoutingLoadError(`failed to read routing config at ${path}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RoutingLoadError(`routing config is not valid JSON: ${path}`, err);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new RoutingLoadError(
      `routing config schemaVersion must be 1 (got ${
        (parsed as { schemaVersion?: unknown })?.schemaVersion ?? "<missing>"
      })`,
    );
  }

  const config = parsed as RoutingConfig;
  const warnings: RoutingLoadWarning[] = [];
  const compiled: CompiledRule[] = [];

  for (const rule of config.rules ?? []) {
    const c = compileRule(rule, warnings);
    if (c) {
      compiled.push(c);
    }
  }

  if (compiled.length === 0) {
    throw new RoutingLoadError(`no routable rules in routing config at ${path}`);
  }

  if (!options.skipAgentValidation) {
    const agentsDir = options.agentsDir ?? defaultAgentsDir();
    if (!agentExists(agentsDir, config.default.agent)) {
      throw new RoutingLoadError(
        `default agent "${config.default.agent}" does not exist under ${agentsDir}`,
      );
    }
    for (const rule of compiled) {
      if (!agentExists(agentsDir, rule.agent)) {
        warnings.push({
          ruleId: rule.id,
          message: `rule's agent "${rule.agent}" does not exist under ${agentsDir}`,
        });
      }
    }
  }

  return {
    config: {
      schemaVersion: 1,
      rules: compiled,
      default: config.default,
      approvalRequired: config.approvalRequired ?? [],
      approvalRequiredCapabilities: config.approvalRequiredCapabilities ?? [],
    },
    warnings,
  };
}

function capabilityFilterPasses(
  rule: CompiledRule,
  taskCapabilities: ReadonlyArray<string>,
): boolean {
  if (rule.capabilities.length === 0) {
    return true;
  }
  const supplied = new Set(taskCapabilities);
  return rule.capabilities.every((c) => supplied.has(c));
}

/**
 * Pick the highest-priority rule whose pattern matches `goal` and whose
 * capability filter is satisfied by `requiredCapabilities`. Falls back
 * to `config.default` when no rule matches.
 */
export function decide(
  goal: string,
  requiredCapabilities: ReadonlyArray<string>,
  config: CompiledRoutingConfig,
): RoutingDecision {
  // Stable sort by priority desc; preserves rule order within a priority bucket.
  const ranked = config.rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const byPriority = b.rule.priority - a.rule.priority;
      if (byPriority !== 0) {
        return byPriority;
      }
      return a.index - b.index;
    });

  for (const { rule } of ranked) {
    if (!rule.regex.test(goal)) {
      continue;
    }
    if (!capabilityFilterPasses(rule, requiredCapabilities)) {
      continue;
    }
    return {
      matchedRuleId: rule.id,
      assignedAgentId: rule.agent,
      capabilityMatches: [...rule.capabilities],
      fallbackUsed: false,
    };
  }

  return {
    matchedRuleId: null,
    assignedAgentId: config.default.agent,
    capabilityMatches: [],
    fallbackUsed: true,
  };
}

/**
 * Find rules at the same priority that *also* matched the goal. Used by
 * the dispatcher to surface a structured warning when shadowing occurs
 * (see Failure Modes F-06).
 */
export function findShadowingMatches(
  goal: string,
  requiredCapabilities: ReadonlyArray<string>,
  config: CompiledRoutingConfig,
  matchedRuleId: string,
): CompiledRule[] {
  const matched = config.rules.find((r) => r.id === matchedRuleId);
  if (!matched) {
    return [];
  }
  return config.rules.filter(
    (r) =>
      r.id !== matchedRuleId &&
      r.priority === matched.priority &&
      r.regex.test(goal) &&
      capabilityFilterPasses(r, requiredCapabilities),
  );
}
