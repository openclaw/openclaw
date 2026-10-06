import { resolveExecModePolicy } from "openclaw/plugin-sdk/exec-approvals-runtime";
import {
  asNonArrayRecord,
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { collectPolicyConfiguredAgents, ocPathSegment } from "./policy-state-helpers.js";
import type { PolicyToolPostureEvidence } from "./policy-state-types.js";

type ExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";

export function scanPolicyToolPosture(
  cfg: Record<string, unknown>,
): readonly PolicyToolPostureEvidence[] {
  const globalTools = asNonArrayRecord(cfg.tools);
  const agents = asNonArrayRecord(cfg.agents);
  const defaults = asNonArrayRecord(agents.defaults);
  const defaultSandbox = asNonArrayRecord(defaults.sandbox);
  const entries: PolicyToolPostureEvidence[] = [];
  pushToolPostureEvidence(entries, {
    id: "tools",
    scope: "global",
    tools: globalTools,
    inheritedTools: {},
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    sourceBase: "oc://openclaw.config/tools",
  });

  collectPolicyConfiguredAgents(agents).forEach((configured) => {
    const agent = configured.value;
    if (!isRecord(agent)) {
      return;
    }
    pushToolPostureEvidence(entries, {
      id: configured.agentId,
      scope: "agent",
      agentId: configured.agentId,
      tools: asNonArrayRecord(agent.tools),
      inheritedTools: globalTools,
      sandbox: asNonArrayRecord(agent.sandbox),
      inheritedSandbox: defaultSandbox,
      sourceBase: `${configured.sourceBase}/tools`,
    });
  });

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function pushToolPostureEvidence(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localProfile = readString(params.tools.profile);
  const inheritedProfile = readString(params.inheritedTools.profile);
  pushToolPostureValue(entries, params, {
    suffix: "profile",
    kind: "profile",
    value: localProfile ?? inheritedProfile ?? "full",
    explicit: localProfile !== undefined || inheritedProfile !== undefined,
    inherited: localProfile === undefined && inheritedProfile !== undefined,
  });

  pushToolPostureList(entries, params, "allow");
  pushToolAlsoAllowPostureList(entries, params);
  pushToolPostureList(entries, params, "deny");
  pushToolFsPosture(entries, params);
  pushToolExecPosture(entries, params);
  pushToolElevatedPosture(entries, params);
}

function pushToolFsPosture(entries: PolicyToolPostureEvidence[], params: ToolPostureParams): void {
  const localFs = asNonArrayRecord(params.tools.fs);
  const inheritedFs = asNonArrayRecord(params.inheritedTools.fs);
  const localWorkspaceOnly = readBoolean(localFs.workspaceOnly);
  const inheritedWorkspaceOnly = readBoolean(inheritedFs.workspaceOnly);
  pushToolPostureValue(entries, params, {
    suffix: "fs/workspaceOnly",
    kind: "fsWorkspaceOnly",
    value: localWorkspaceOnly ?? inheritedWorkspaceOnly ?? false,
    explicit: localWorkspaceOnly !== undefined || inheritedWorkspaceOnly !== undefined,
    inherited: localWorkspaceOnly === undefined && inheritedWorkspaceOnly !== undefined,
  });
}

function pushToolExecPosture(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localExec = asNonArrayRecord(params.tools.exec);
  const inheritedExec = asNonArrayRecord(params.inheritedTools.exec);
  const localHost = readString(localExec.host);
  const inheritedHost = readString(inheritedExec.host);
  const host = localHost ?? inheritedHost ?? "auto";
  pushToolPostureValue(entries, params, {
    suffix: "exec/host",
    kind: "execHost",
    value: host,
    explicit: localHost !== undefined || inheritedHost !== undefined,
    inherited: localHost === undefined && inheritedHost !== undefined,
  });

  const localSecurity = readString(localExec.security);
  const inheritedSecurity = readString(inheritedExec.security);
  const localAsk = readString(localExec.ask);
  const inheritedAsk = readString(inheritedExec.ask);
  const localMode = readExecMode(localExec.mode);
  const inheritedMode = readExecMode(inheritedExec.mode);
  // Config conformance intentionally ignores exec-approvals.json runtime/operator state.
  const sandboxMode = readString(params.sandbox.mode) ?? readString(params.inheritedSandbox.mode);
  const sandboxCanApply = sandboxMode === "all";
  const defaultSecurity =
    host === "sandbox" || (host === "auto" && sandboxCanApply) ? "deny" : "full";
  const selectedMode =
    localMode === undefined
      ? inheritedMode === undefined
        ? undefined
        : { value: inheritedMode, inherited: true }
      : { value: localMode, inherited: false };
  const modePosture =
    selectedMode === undefined
      ? undefined
      : {
          ...selectedMode,
          // A selected mode owns both posture fields, so the resolver ignores legacy inputs.
          ...resolveExecModePolicy({
            mode: selectedMode.value,
            security: "full",
            ask: "off",
          }),
        };
  for (const [field, kind, local, inherited, fallback] of [
    ["security", "execSecurity", localSecurity, inheritedSecurity, defaultSecurity],
    ["ask", "execAsk", localAsk, inheritedAsk, "off"],
  ] as const) {
    const usesMode =
      modePosture?.inherited === false || (local === undefined && modePosture?.inherited === true);
    pushToolPostureValue(entries, params, {
      suffix: `exec/${field}`,
      sourceSuffix: usesMode ? "exec/mode" : undefined,
      kind,
      value:
        modePosture?.inherited === false
          ? modePosture[field]
          : (local ?? modePosture?.[field] ?? inherited ?? fallback),
      explicit: modePosture !== undefined || local !== undefined || inherited !== undefined,
      inherited:
        modePosture?.inherited === true
          ? local === undefined
          : local === undefined && inherited !== undefined,
    });
  }
}

function pushToolElevatedPosture(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localElevated = asNonArrayRecord(params.tools.elevated);
  const inheritedElevated = asNonArrayRecord(params.inheritedTools.elevated);
  const localEnabled = readBoolean(localElevated.enabled);
  const inheritedEnabled = readBoolean(inheritedElevated.enabled);
  const effectiveEnabled =
    inheritedEnabled === false ? false : (localEnabled ?? inheritedEnabled ?? true);
  pushToolPostureValue(entries, params, {
    suffix: "elevated/enabled",
    kind: "elevatedEnabled",
    value: effectiveEnabled,
    explicit: localEnabled !== undefined || inheritedEnabled !== undefined,
    inherited:
      (inheritedEnabled === false && localEnabled !== false) ||
      (localEnabled === undefined && inheritedEnabled !== undefined),
  });

  const localAllowFrom = asNonArrayRecord(localElevated.allowFrom);
  const inheritedAllowFrom = asNonArrayRecord(inheritedElevated.allowFrom);
  const providers = [
    ...new Set([...Object.keys(inheritedAllowFrom), ...Object.keys(localAllowFrom)]),
  ].toSorted((a, b) => a.localeCompare(b));
  for (const provider of providers) {
    const localEntries = readStringOrNumberArray(localAllowFrom[provider]);
    const inheritedEntries = readStringOrNumberArray(inheritedAllowFrom[provider]);
    const inherited = localEntries.length === 0 && inheritedEntries.length > 0;
    entries.push({
      id: `${params.id}-elevated-allow-from-${ocPathSegment(provider)}`,
      kind: "elevatedAllowFrom",
      source: `${inherited ? "oc://openclaw.config/tools" : params.sourceBase}/elevated/allowFrom/${ocPathSegment(provider)}`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      entries: localEntries.length > 0 ? localEntries : inheritedEntries,
      explicit: localEntries.length > 0 || inheritedEntries.length > 0,
    });
  }
}

type ToolPostureParams = {
  readonly id: string;
  readonly scope: "global" | "agent";
  readonly agentId?: string;
  readonly tools: Record<string, unknown>;
  readonly inheritedTools: Record<string, unknown>;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
  readonly sourceBase: string;
};

function pushToolPostureValue(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
  entry: {
    readonly suffix: string;
    readonly sourceSuffix?: string;
    readonly kind: PolicyToolPostureEvidence["kind"];
    readonly value: boolean | string | undefined;
    readonly explicit: boolean;
    readonly inherited: boolean;
  },
): void {
  entries.push({
    id: `${params.id}-${entry.suffix.replaceAll("/", "-")}`,
    kind: entry.kind,
    source: `${entry.inherited ? "oc://openclaw.config/tools" : params.sourceBase}/${entry.sourceSuffix ?? entry.suffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
    explicit: entry.explicit,
  });
}

function readExecMode(value: unknown): ExecMode | undefined {
  const mode = readString(value)?.toLowerCase();
  switch (mode) {
    case "deny":
    case "allowlist":
    case "ask":
    case "auto":
    case "full":
      return mode;
    default:
      return undefined;
  }
}

function pushToolPostureList(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
  key: "allow" | "deny",
): void {
  const localEntries = readStringArray(params.tools[key]);
  const inheritedEntries = readStringArray(params.inheritedTools[key]);
  const inherited = localEntries.length === 0 && inheritedEntries.length > 0;
  entries.push({
    id: `${params.id}-${key}`,
    kind: key,
    source: `${inherited ? "oc://openclaw.config/tools" : params.sourceBase}/${key}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    entries: [...inheritedEntries, ...localEntries],
    explicit: localEntries.length > 0 || inheritedEntries.length > 0,
  });
}

function pushToolAlsoAllowPostureList(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localValue = params.tools.alsoAllow;
  const inheritedValue = params.inheritedTools.alsoAllow;
  const localConfigured = Array.isArray(localValue);
  const inheritedConfigured = Array.isArray(inheritedValue);
  const localEntries = readStringArray(localValue);
  const inheritedEntries = readStringArray(inheritedValue);
  const inherited = !localConfigured && inheritedConfigured;
  entries.push({
    id: `${params.id}-alsoAllow`,
    kind: "alsoAllow",
    source: `${inherited ? "oc://openclaw.config/tools" : params.sourceBase}/alsoAllow`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    entries: inherited ? inheritedEntries : localEntries,
    explicit: localConfigured || inheritedConfigured,
  });
}

export const AGENT_WORKSPACE_POLICY_TOOLS = [
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
] as const;

export const IMPLICIT_DEFAULT_ACCOUNT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  discord: ["token"],
  googlechat: ["serviceAccount", "serviceAccountFile"],
  imessage: ["cliPath", "dbPath"],
  "qa-channel": ["baseUrl"],
  qqbot: ["appId", "clientSecret", "clientSecretFile"],
  signal: ["account"],
  slack: ["appToken", "botToken", "signingSecret"],
  "synology-chat": ["token"],
  telegram: ["botToken", "tokenFile"],
  tlon: ["ship"],
  twitch: ["username"],
  whatsapp: ["authDir"],
  zalo: ["botToken", "tokenFile"],
  zalouser: ["profile"],
};

export function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readStringOrNumberArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      entries.push(entry.trim());
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      entries.push(String(entry));
    }
  }
  return entries;
}
