import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type EnforcementMode = "off" | "shadow" | "enforce";
type GovernanceDecision = "permit" | "prohibit" | "escalate";

type RuntimeRuleMatch = {
  toolName?: string | string[];
  action?: string | string[];
  pathPattern?: string | string[];
};

type RuntimeRule = {
  id: string;
  priority?: number;
  decision: GovernanceDecision;
  reasonCode: string;
  reasonText?: string;
  match?: RuntimeRuleMatch;
};

type RuntimePolicy = {
  version: string;
  defaultDecision?: GovernanceDecision;
  rules?: RuntimeRule[];
};

type GovernancePluginConfig = {
  mode?: EnforcementMode;
  policyFile?: string;
  emitDecisionLog?: boolean;
  mutatingTools?: string[];
};

type EvaluationInput = {
  toolName: string;
  action?: string;
  path?: string;
};

type EvaluatedDecision = {
  decision: GovernanceDecision;
  reasonCode: string;
  reasonText?: string;
  policyVersion?: string;
  ruleId?: string;
};

const DEFAULT_MUTATING_TOOLS = new Set(
  [
    "write",
    "edit",
    "apply_patch",
    "exec",
    "bash",
    "move",
    "rename",
    "delete",
    "rm",
    "process",
    "cron",
  ].map((entry) => entry.toLowerCase()),
);

const CONFIG_MODES = new Set<EnforcementMode>(["off", "shadow", "enforce"]);

let policyCache: {
  path: string;
  loadedAtMs: number;
  policy: RuntimePolicy;
} | null = null;
const POLICY_CACHE_TTL_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length > 0 ? items : undefined;
}

function normalizeMode(value: unknown): EnforcementMode {
  const normalized = asTrimmedString(value)?.toLowerCase();
  if (normalized && CONFIG_MODES.has(normalized as EnforcementMode)) {
    return normalized as EnforcementMode;
  }
  return "off";
}

function normalizeDecision(value: unknown): GovernanceDecision | undefined {
  const normalized = asTrimmedString(value)?.toLowerCase();
  if (
    normalized === "permit" ||
    normalized === "prohibit" ||
    normalized === "escalate"
  ) {
    return normalized;
  }
  return undefined;
}

function toList(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry.toLowerCase());
  }
  return [value.toLowerCase()];
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPathPattern(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }
  for (const pattern of patterns) {
    const regex = wildcardToRegExp(pattern);
    if (regex.test(path)) {
      return true;
    }
  }
  return false;
}

function resolveAction(params: Record<string, unknown>): string | undefined {
  return asTrimmedString(params.action)?.toLowerCase();
}

function resolvePath(params: Record<string, unknown>): string | undefined {
  return (
    asTrimmedString(params.path) ??
    asTrimmedString(params.filePath) ??
    asTrimmedString(params.file_path) ??
    asTrimmedString(params.target) ??
    asTrimmedString(params.destination)
  );
}

function normalizePolicy(input: unknown): RuntimePolicy {
  const parsed = asRecord(input);
  if (!parsed) {
    throw new Error("Policy must be an object");
  }
  const version = asTrimmedString(parsed.version);
  if (!version) {
    throw new Error("Policy is missing version");
  }
  const defaultDecision = normalizeDecision(parsed.defaultDecision) ?? "permit";

  const rules: RuntimeRule[] = [];
  const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  for (const rawRule of rawRules) {
    const rule = asRecord(rawRule);
    if (!rule) {
      continue;
    }
    const id = asTrimmedString(rule.id);
    const reasonCode = asTrimmedString(rule.reasonCode);
    const decision = normalizeDecision(rule.decision);
    if (!id || !reasonCode || !decision) {
      continue;
    }
    const rawMatch = asRecord(rule.match);
    const match: RuntimeRuleMatch | undefined = rawMatch
      ? {
          toolName:
            asTrimmedString(rawMatch.toolName) ??
            asStringList(rawMatch.toolName as unknown as string[]) ??
            undefined,
          action:
            asTrimmedString(rawMatch.action) ??
            asStringList(rawMatch.action as unknown as string[]) ??
            undefined,
          pathPattern:
            asTrimmedString(rawMatch.pathPattern) ??
            asStringList(rawMatch.pathPattern as unknown as string[]) ??
            undefined,
        }
      : undefined;

    rules.push({
      id,
      priority: typeof rule.priority === "number" ? rule.priority : 0,
      decision,
      reasonCode,
      reasonText: asTrimmedString(rule.reasonText),
      match,
    });
  }

  rules.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));

  return {
    version,
    defaultDecision,
    rules,
  };
}

async function readPolicy(policyFile: string): Promise<RuntimePolicy> {
  const now = Date.now();
  if (
    policyCache &&
    policyCache.path === policyFile &&
    now - policyCache.loadedAtMs < POLICY_CACHE_TTL_MS
  ) {
    return policyCache.policy;
  }
  const text = await fs.readFile(policyFile, "utf8");
  const policy = normalizePolicy(JSON.parse(text) as unknown);
  policyCache = {
    path: policyFile,
    loadedAtMs: now,
    policy,
  };
  return policy;
}

function matchesRule(rule: RuntimeRule, input: EvaluationInput): boolean {
  const match = rule.match;
  if (!match) {
    return true;
  }
  const ruleTools = toList(match.toolName);
  if (ruleTools.length > 0 && !ruleTools.includes(input.toolName.toLowerCase())) {
    return false;
  }
  const ruleActions = toList(match.action);
  if (ruleActions.length > 0) {
    if (!input.action || !ruleActions.includes(input.action.toLowerCase())) {
      return false;
    }
  }
  const pathPatterns = toList(match.pathPattern);
  if (pathPatterns.length > 0) {
    if (!input.path || !matchesPathPattern(input.path, pathPatterns)) {
      return false;
    }
  }
  return true;
}

function evaluatePolicy(policy: RuntimePolicy, input: EvaluationInput): EvaluatedDecision {
  const matchedRule = policy.rules?.find((rule) => matchesRule(rule, input));
  if (matchedRule) {
    return {
      decision: matchedRule.decision,
      reasonCode: matchedRule.reasonCode,
      reasonText: matchedRule.reasonText,
      policyVersion: policy.version,
      ruleId: matchedRule.id,
    };
  }
  return {
    decision: policy.defaultDecision ?? "permit",
    reasonCode: "GOVERNANCE_DEFAULT_DECISION",
    reasonText: "No explicit policy rule matched",
    policyVersion: policy.version,
  };
}

function isMutatingTool(
  toolName: string,
  params: Record<string, unknown>,
  mutatingTools: Set<string>,
): boolean {
  const normalizedTool = toolName.toLowerCase();
  if (mutatingTools.has(normalizedTool)) {
    return true;
  }
  const action = resolveAction(params);
  if (!action) {
    return false;
  }
  // `cron` can be read-only, so treat explicit mutating actions as governed.
  if (normalizedTool === "cron" && (action === "add" || action === "remove" || action === "update")) {
    return true;
  }
  return false;
}

function resolveMutatingTools(config: GovernancePluginConfig): Set<string> {
  const custom = asStringList(config.mutatingTools)?.map((entry) => entry.toLowerCase());
  if (!custom || custom.length === 0) {
    return new Set(DEFAULT_MUTATING_TOOLS);
  }
  return new Set(custom);
}

function formatBlockReason(prefix: string, decision: EvaluatedDecision): string {
  const suffix = decision.reasonText ? `: ${decision.reasonText}` : "";
  return `${prefix}: ${decision.reasonCode}${suffix}`;
}

const plugin = {
  id: "frankos-governance",
  name: "FrankOS Governance",
  description: "Runtime governance guardrails for constitutional decision enforcement.",
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as GovernancePluginConfig;
    const mode = normalizeMode(config.mode);
    const emitDecisionLog = config.emitDecisionLog !== false;
    const policyFile = asTrimmedString(config.policyFile);
    const mutatingTools = resolveMutatingTools(config);

    api.on("before_tool_call", async (event, ctx) => {
      if (mode === "off") {
        return;
      }
      const params = asRecord(event.params) ?? {};
      const toolName = asTrimmedString(event.toolName)?.toLowerCase() ?? "unknown";
      if (!isMutatingTool(toolName, params, mutatingTools)) {
        return;
      }

      const startedAt = Date.now();
      const emitDecision = (decision: EvaluatedDecision) => {
        if (!emitDecisionLog) {
          return;
        }
        api.runtime.events.emitDiagnosticEvent({
          type: "governance.decision",
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          runId: event.runId,
          toolName,
          decision: decision.decision,
          mode,
          reasonCode: decision.reasonCode,
          reasonText: decision.reasonText,
          policyVersion: decision.policyVersion,
          ruleId: decision.ruleId,
          durationMs: Date.now() - startedAt,
        });
      };

      if (!policyFile) {
        const decision: EvaluatedDecision = {
          decision: "escalate",
          reasonCode: "GOVERNANCE_POLICY_FILE_MISSING",
          reasonText: "No policyFile configured",
        };
        emitDecision(decision);
        if (mode === "enforce") {
          return {
            block: true,
            blockReason: formatBlockReason("GOVERNANCE_POLICY_EVAL_FAILED", decision),
          };
        }
        return;
      }

      try {
        const policy = await readPolicy(policyFile);
        const decision = evaluatePolicy(policy, {
          toolName,
          action: resolveAction(params),
          path: resolvePath(params),
        });
        emitDecision(decision);
        if (mode === "shadow" || decision.decision === "permit") {
          return;
        }
        if (decision.decision === "prohibit") {
          return {
            block: true,
            blockReason: formatBlockReason("GOVERNANCE_PROHIBITED", decision),
          };
        }
        return {
          block: true,
          blockReason: formatBlockReason("GOVERNANCE_ESCALATE_REQUIRED", decision),
        };
      } catch (error) {
        const fallbackDecision: EvaluatedDecision = {
          decision: "escalate",
          reasonCode: "GOVERNANCE_POLICY_EVAL_FAILED",
          reasonText: error instanceof Error ? error.message : String(error),
        };
        emitDecision(fallbackDecision);
        if (mode === "enforce") {
          return {
            block: true,
            blockReason: formatBlockReason("GOVERNANCE_POLICY_EVAL_FAILED", fallbackDecision),
          };
        }
      }
    });
  },
};

export default plugin;
