import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type EnforcementMode = "off" | "shadow" | "enforce";
type GovernanceDecision = "permit" | "prohibit" | "escalate";

type PolicyCondition = {
  path: string;
  equals: unknown;
};

type EnumConstraint = {
  path: string;
  allowed: Array<string | number | boolean>;
};

type NumberRangeConstraint = {
  path: string;
  min?: number;
  max?: number;
};

type ArrayMinLengthConstraint = {
  path: string;
  minLength: number;
};

type RuntimeRuleMatch = {
  toolName?: string | string[];
  action?: string | string[];
};

type RuntimeRuleConstraints = {
  when?: PolicyCondition[];
  requiredPaths?: string[];
  enumPaths?: EnumConstraint[];
  numberRanges?: NumberRangeConstraint[];
  arrayMinLengths?: ArrayMinLengthConstraint[];
};

type RuntimeRule = {
  id: string;
  priority?: number;
  decision: GovernanceDecision;
  reasonCode: string;
  reasonText?: string;
  match?: RuntimeRuleMatch;
  constraints?: RuntimeRuleConstraints;
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
  memoryMutatingTools?: string[];
};

type ValidationFailure = {
  missingPaths: string[];
  invalidPaths: string[];
};

type EvaluatedDecision = {
  decision: GovernanceDecision;
  reasonCode: string;
  reasonText?: string;
  policyVersion?: string;
  ruleId?: string;
  validationFailure?: ValidationFailure;
};

const DEFAULT_MEMORY_MUTATING_TOOLS = new Set(["memory_store", "memory_forget"]);
const CONFIG_MODES = new Set<EnforcementMode>(["off", "shadow", "enforce"]);
const POLICY_CACHE_TTL_MS = 10_000;

let policyCache: {
  path: string;
  loadedAtMs: number;
  policy: RuntimePolicy;
} | null = null;

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
  if (normalized === "permit" || normalized === "prohibit" || normalized === "escalate") {
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

function getPathValue(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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
    const rawConstraints = asRecord(rule.constraints);

    const constraints: RuntimeRuleConstraints | undefined = rawConstraints
      ? {
          when: Array.isArray(rawConstraints.when)
            ? rawConstraints.when
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry))
                .map((entry) => ({
                  path: asTrimmedString(entry.path) ?? "",
                  equals: entry.equals,
                }))
                .filter((entry) => entry.path.length > 0)
            : undefined,
          requiredPaths: asStringList(rawConstraints.requiredPaths),
          enumPaths: Array.isArray(rawConstraints.enumPaths)
            ? rawConstraints.enumPaths
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry))
                .map((entry) => ({
                  path: asTrimmedString(entry.path) ?? "",
                  allowed: Array.isArray(entry.allowed)
                    ? entry.allowed.filter(
                        (candidate): candidate is string | number | boolean =>
                          typeof candidate === "string" ||
                          typeof candidate === "number" ||
                          typeof candidate === "boolean",
                      )
                    : [],
                }))
                .filter((entry) => entry.path.length > 0 && entry.allowed.length > 0)
            : undefined,
          numberRanges: Array.isArray(rawConstraints.numberRanges)
            ? rawConstraints.numberRanges
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry))
                .map((entry) => ({
                  path: asTrimmedString(entry.path) ?? "",
                  min: typeof entry.min === "number" ? entry.min : undefined,
                  max: typeof entry.max === "number" ? entry.max : undefined,
                }))
                .filter((entry) => entry.path.length > 0)
            : undefined,
          arrayMinLengths: Array.isArray(rawConstraints.arrayMinLengths)
            ? rawConstraints.arrayMinLengths
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry))
                .map((entry) => ({
                  path: asTrimmedString(entry.path) ?? "",
                  minLength: typeof entry.minLength === "number" ? entry.minLength : 0,
                }))
                .filter((entry) => entry.path.length > 0)
            : undefined,
        }
      : undefined;

    rules.push({
      id,
      priority: typeof rule.priority === "number" ? rule.priority : 0,
      decision,
      reasonCode,
      reasonText: asTrimmedString(rule.reasonText),
      match: rawMatch
        ? {
            toolName:
              asTrimmedString(rawMatch.toolName) ??
              asStringList(rawMatch.toolName as unknown as string[]) ??
              undefined,
            action:
              asTrimmedString(rawMatch.action) ??
              asStringList(rawMatch.action as unknown as string[]) ??
              undefined,
          }
        : undefined,
      constraints,
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

function ruleMatchesTool(
  rule: RuntimeRule,
  input: { toolName: string; action?: string },
): boolean {
  const match = rule.match;
  if (!match) {
    return true;
  }
  const toolNames = toList(match.toolName);
  if (toolNames.length > 0 && !toolNames.includes(input.toolName.toLowerCase())) {
    return false;
  }
  const actions = toList(match.action);
  if (actions.length > 0) {
    if (!input.action || !actions.includes(input.action.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function conditionMatches(params: Record<string, unknown>, condition: PolicyCondition): boolean {
  return getPathValue(params, condition.path) === condition.equals;
}

function evaluateConstraints(
  constraints: RuntimeRuleConstraints | undefined,
  params: Record<string, unknown>,
): ValidationFailure | null {
  if (!constraints) {
    return null;
  }

  if (constraints.when && constraints.when.length > 0) {
    const active = constraints.when.every((condition) => conditionMatches(params, condition));
    if (!active) {
      return null;
    }
  }

  const missingPaths: string[] = [];
  const invalidPaths: string[] = [];

  for (const path of constraints.requiredPaths ?? []) {
    const value = getPathValue(params, path);
    if (value === undefined || value === null || value === "") {
      missingPaths.push(path);
    }
  }

  for (const entry of constraints.enumPaths ?? []) {
    const value = getPathValue(params, entry.path);
    if (value === undefined || !entry.allowed.includes(value as string | number | boolean)) {
      invalidPaths.push(entry.path);
    }
  }

  for (const entry of constraints.numberRanges ?? []) {
    const value = getPathValue(params, entry.path);
    if (typeof value !== "number") {
      invalidPaths.push(entry.path);
      continue;
    }
    if (typeof entry.min === "number" && value < entry.min) {
      invalidPaths.push(entry.path);
      continue;
    }
    if (typeof entry.max === "number" && value > entry.max) {
      invalidPaths.push(entry.path);
    }
  }

  for (const entry of constraints.arrayMinLengths ?? []) {
    const value = getPathValue(params, entry.path);
    if (!Array.isArray(value) || value.length < entry.minLength) {
      invalidPaths.push(entry.path);
    }
  }

  if (missingPaths.length === 0 && invalidPaths.length === 0) {
    return null;
  }

  return { missingPaths, invalidPaths };
}

function evaluatePolicy(
  policy: RuntimePolicy,
  input: { toolName: string; action?: string; params: Record<string, unknown> },
): EvaluatedDecision {
  for (const rule of policy.rules ?? []) {
    if (!ruleMatchesTool(rule, input)) {
      continue;
    }
    const failure = evaluateConstraints(rule.constraints, input.params);
    if (!failure) {
      continue;
    }
    return {
      decision: rule.decision,
      reasonCode: rule.reasonCode,
      reasonText: rule.reasonText,
      policyVersion: policy.version,
      ruleId: rule.id,
      validationFailure: failure,
    };
  }

  return {
    decision: policy.defaultDecision ?? "permit",
    reasonCode: "MEMORY_GOVERNANCE_DEFAULT_DECISION",
    reasonText: "No memory governance rule violation detected",
    policyVersion: policy.version,
  };
}

function resolveMutatingTools(config: GovernancePluginConfig): Set<string> {
  const custom = asStringList(config.memoryMutatingTools)?.map((entry) => entry.toLowerCase());
  if (!custom || custom.length === 0) {
    return new Set(DEFAULT_MEMORY_MUTATING_TOOLS);
  }
  return new Set(custom);
}

function formatBlockReason(prefix: string, decision: EvaluatedDecision): string {
  const suffix = decision.reasonText ? `: ${decision.reasonText}` : "";
  return `${prefix}: ${decision.reasonCode}${suffix}`;
}

function resolveAction(params: Record<string, unknown>): string | undefined {
  return asTrimmedString(params.action)?.toLowerCase();
}

function resolveClassification(params: Record<string, unknown>): "observed" | "inferred" | "unknown" {
  const value = asTrimmedString(getPathValue(params, "metadata.classification"));
  if (value === "observed" || value === "inferred") {
    return value;
  }
  return "unknown";
}

function resolveConfidence(params: Record<string, unknown>): number | undefined {
  const value = getPathValue(params, "metadata.confidence");
  return typeof value === "number" ? value : undefined;
}

const plugin = {
  id: "frankos-memory-governance",
  name: "FrankOS Memory Governance",
  description: "Runtime memory integrity guardrails for provenance and traceability.",
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
      const toolName = asTrimmedString(event.toolName)?.toLowerCase() ?? "unknown";
      if (!mutatingTools.has(toolName)) {
        return;
      }

      const params = asRecord(event.params) ?? {};
      const startedAt = Date.now();
      const classification = resolveClassification(params);
      const confidence = resolveConfidence(params);

      const emitDecision = (decision: EvaluatedDecision) => {
        if (!emitDecisionLog) {
          return;
        }

        api.runtime.events.emitDiagnosticEvent({
          type: "memory.governance.decision",
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
          classification,
          confidence,
          durationMs: Date.now() - startedAt,
        });

        if (decision.validationFailure) {
          api.runtime.events.emitDiagnosticEvent({
            type: "memory.provenance.validation_failure",
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            runId: event.runId,
            toolName,
            reasonCode: decision.reasonCode,
            missingPaths: decision.validationFailure.missingPaths,
            invalidPaths: decision.validationFailure.invalidPaths,
            mode,
          });
        }
      };

      const emitSupersession = () => {
        const correction = getPathValue(params, "metadata.correction");
        const supersedes = getPathValue(params, "metadata.supersedes");
        if (correction !== true || !Array.isArray(supersedes) || supersedes.length === 0) {
          return;
        }
        const supersedesIds = supersedes
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (supersedesIds.length === 0) {
          return;
        }
        api.runtime.events.emitDiagnosticEvent({
          type: "memory.correction.supersession",
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          runId: event.runId,
          toolName,
          action: "linked",
          supersedes: supersedesIds,
        });
      };

      if (!policyFile) {
        const missingDecision: EvaluatedDecision = {
          decision: "escalate",
          reasonCode: "MEMORY_POLICY_FILE_MISSING",
          reasonText: "No memory governance policyFile configured",
        };
        emitDecision(missingDecision);
        if (mode === "enforce") {
          return {
            block: true,
            blockReason: formatBlockReason("MEMORY_POLICY_EVAL_FAILED", missingDecision),
          };
        }
        return;
      }

      try {
        const policy = await readPolicy(policyFile);
        const decision = evaluatePolicy(policy, {
          toolName,
          action: resolveAction(params),
          params,
        });
        emitDecision(decision);
        emitSupersession();
        if (mode === "shadow" || decision.decision === "permit") {
          return;
        }
        if (decision.decision === "prohibit") {
          return {
            block: true,
            blockReason: formatBlockReason("MEMORY_GOVERNANCE_PROHIBITED", decision),
          };
        }
        return {
          block: true,
          blockReason: formatBlockReason("MEMORY_GOVERNANCE_ESCALATE_REQUIRED", decision),
        };
      } catch (error) {
        const fallbackDecision: EvaluatedDecision = {
          decision: "escalate",
          reasonCode: "MEMORY_POLICY_EVAL_FAILED",
          reasonText: error instanceof Error ? error.message : String(error),
        };
        emitDecision(fallbackDecision);
        if (mode === "enforce") {
          return {
            block: true,
            blockReason: formatBlockReason("MEMORY_POLICY_EVAL_FAILED", fallbackDecision),
          };
        }
      }
    });
  },
};

export default plugin;
