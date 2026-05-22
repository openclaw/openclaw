import { parse as parseYaml } from "yaml";

export type RobotConstitution = {
  autoAllow: string[];
  hitlRequired: string[];
  deny: string[];
  trustedSources: string[];
  dedupWindowMs: number;
};

export const DEFAULT_ROBOT_CONSTITUTION: RobotConstitution = {
  autoAllow: ["query.object_store", "notify", "query.alarms", "event.publish:system.*"],
  hitlRequired: ["a2a_delegate", "create.work_order", "modify.device_config"],
  deny: ["delete.*", "modify.production.*", "share.credentials"],
  trustedSources: [
    "system",
    "connector",
    "peer",
    "channel_user",
    "apikey",
    "openclaw_agent",
    "test",
    "playbook",
    "im",
    "im-bridge",
    "webhook",
    "webhook-bridge",
    "rest",
    "rest-api",
    "playbook-action",
    "mcp",
    "a2a",
  ],
  dedupWindowMs: 60_000,
};

const CONSTITUTION_FENCE = /```(?:yaml)?\s*constitution\s*([\s\S]*?)```/i;

export function parseRobotConstitutionFromMd(md: string): RobotConstitution {
  const match = md.match(CONSTITUTION_FENCE);
  if (!match?.[1]) {
    return { ...DEFAULT_ROBOT_CONSTITUTION };
  }
  try {
    const raw = parseYaml(match[1]) as Record<string, unknown>;
    return normalizeConstitution(raw);
  } catch {
    return { ...DEFAULT_ROBOT_CONSTITUTION };
  }
}

function normalizeConstitution(raw: Record<string, unknown>): RobotConstitution {
  const list = (key: string, fallback: string[]) => {
    const v = raw[key] ?? raw[key.replace(/_/g, "")];
    return Array.isArray(v) ? v.map(String) : fallback;
  };
  const dedup =
    typeof raw.dedup_window_ms === "number"
      ? raw.dedup_window_ms
      : typeof raw.dedup_window === "string"
        ? parseDurationMs(String(raw.dedup_window))
        : DEFAULT_ROBOT_CONSTITUTION.dedupWindowMs;

  const customTrusted = raw.trusted_sources ?? raw.trustedSources;
  const trustedSources = Array.isArray(customTrusted)
    ? [...new Set([...DEFAULT_ROBOT_CONSTITUTION.trustedSources, ...customTrusted.map(String)])]
    : DEFAULT_ROBOT_CONSTITUTION.trustedSources;

  return {
    autoAllow: list("auto_allow", DEFAULT_ROBOT_CONSTITUTION.autoAllow),
    hitlRequired: list("hitl_required", DEFAULT_ROBOT_CONSTITUTION.hitlRequired),
    deny: list("deny", DEFAULT_ROBOT_CONSTITUTION.deny),
    trustedSources,
    dedupWindowMs: dedup > 0 ? dedup : DEFAULT_ROBOT_CONSTITUTION.dedupWindowMs,
  };
}

function parseDurationMs(spec: string): number {
  const m = spec.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) {
    return DEFAULT_ROBOT_CONSTITUTION.dedupWindowMs;
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") {
    return n;
  }
  if (unit === "m") {
    return n * 60_000;
  }
  if (unit === "h") {
    return n * 3_600_000;
  }
  return n * 1000;
}

/** Map playbook / REST operations to constitution capability tokens. */
export function capabilityForPlaybookAction(actionApiName: string): string {
  if (actionApiName === "create_work_order") {
    return "create.work_order";
  }
  if (actionApiName.startsWith("create_")) {
    return `create.${actionApiName.replace(/^create_/, "").replace(/_/g, ".")}`;
  }
  if (actionApiName.startsWith("modify_")) {
    return `modify.${actionApiName.replace(/^modify_/, "").replace(/_/g, ".")}`;
  }
  if (actionApiName.startsWith("delete_")) {
    return `delete.${actionApiName.replace(/^delete_/, "").replace(/_/g, ".")}`;
  }
  return actionApiName.replace(/_/g, ".");
}

export function capabilityForStepKind(
  kind: string,
  detail?: { actionApiName?: string; functionApiName?: string },
): string {
  if (kind === "notification") {
    return "notify";
  }
  if (kind === "a2a_delegate") {
    return "a2a_delegate";
  }
  if (kind === "hitl") {
    return "hitl.resolve";
  }
  if (kind === "action" && detail?.actionApiName) {
    return capabilityForPlaybookAction(detail.actionApiName);
  }
  if (kind === "function" && detail?.functionApiName?.toLowerCase().includes("query")) {
    return "query.object_store";
  }
  return kind;
}

function matchesConstitutionPattern(pattern: string, capability: string): boolean {
  if (pattern === capability) {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return capability.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith("*") && !pattern.includes(".")) {
    return capability.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export type ConstitutionCheckResult =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "hitl_required"; reason: string };

export function checkRobotConstitution(
  constitution: RobotConstitution,
  capability: string,
): ConstitutionCheckResult {
  for (const pattern of constitution.deny) {
    if (matchesConstitutionPattern(pattern, capability)) {
      return { decision: "deny", reason: `Constitution deny: ${pattern}` };
    }
  }
  for (const pattern of constitution.hitlRequired) {
    if (matchesConstitutionPattern(pattern, capability)) {
      return { decision: "hitl_required", reason: `Constitution requires HITL: ${pattern}` };
    }
  }
  for (const pattern of constitution.autoAllow) {
    if (matchesConstitutionPattern(pattern, capability)) {
      return { decision: "allow" };
    }
  }
  return { decision: "allow" };
}

export function isTrustedEventSource(
  constitution: RobotConstitution | undefined,
  source: string,
): boolean {
  if (!constitution) {
    return true;
  }
  const prefix = source.split(":")[0]?.toLowerCase() ?? source;
  return constitution.trustedSources.some((t) => {
    if (t === prefix) {
      return true;
    }
    if (t === "openclaw_agent" && (prefix === "agent" || source.startsWith("openclaw:"))) {
      return true;
    }
    if (source.startsWith(`${t}:`)) {
      return true;
    }
    if (t === "im" && (prefix === "im" || source.startsWith("im:"))) {
      return true;
    }
    if (prefix.endsWith("-bridge") && (prefix === t || prefix.startsWith(`${t}-`))) {
      return true;
    }
    return false;
  });
}
