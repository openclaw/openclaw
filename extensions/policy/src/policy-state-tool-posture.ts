import { resolveExecModePolicy } from "openclaw/plugin-sdk/exec-approvals-runtime";
import {
  asNonArrayRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyAgentContexts,
  ocPathSegment,
  resolvePolicyValue,
} from "./policy-state-helpers.js";
import type { PolicyToolPostureEvidence } from "./policy-state-types.js";

type ExecMode = ReturnType<typeof resolveExecModePolicy>["mode"];

export function scanPolicyToolPosture(
  cfg: Record<string, unknown>,
): readonly PolicyToolPostureEvidence[] {
  const entries: PolicyToolPostureEvidence[] = [];
  for (const context of collectPolicyAgentContexts(cfg, "global")) {
    pushToolPostureValue({
      suffix: "profile",
      kind: "profile",
      ...resolvePolicyValue(
        readString(context.tools.profile),
        readString(context.inheritedTools.profile),
        "full",
      ),
    });

    for (const key of ["allow", "alsoAllow", "deny"] as const) {
      const localValue = context.tools[key];
      const inheritedValue = context.inheritedTools[key];
      const localEntries = readStringArray(localValue);
      const inheritedEntries = readStringArray(inheritedValue);
      const replace = key === "alsoAllow";
      const localConfigured = replace ? Array.isArray(localValue) : localEntries.length > 0;
      const inheritedConfigured = replace
        ? Array.isArray(inheritedValue)
        : inheritedEntries.length > 0;
      const inherited = !localConfigured && inheritedConfigured;
      pushToolPostureValue({
        suffix: key,
        kind: key,
        inherited,
        entries: replace
          ? inherited
            ? inheritedEntries
            : localEntries
          : [...inheritedEntries, ...localEntries],
        explicit: localConfigured || inheritedConfigured,
      });
    }
    const localFs = asNonArrayRecord(context.tools.fs);
    const inheritedFs = asNonArrayRecord(context.inheritedTools.fs);
    pushToolPostureValue({
      suffix: "fs/workspaceOnly",
      kind: "fsWorkspaceOnly",
      ...resolvePolicyValue(
        readBoolean(localFs.workspaceOnly),
        readBoolean(inheritedFs.workspaceOnly),
        false,
      ),
    });
    const localExec = asNonArrayRecord(context.tools.exec);
    const inheritedExec = asNonArrayRecord(context.inheritedTools.exec);
    const hostPosture = resolvePolicyValue(
      readString(localExec.host),
      readString(inheritedExec.host),
      "auto",
    );
    const host = hostPosture.value;
    pushToolPostureValue({
      suffix: "exec/host",
      kind: "execHost",
      ...hostPosture,
    });

    const localSecurity = readString(localExec.security);
    const inheritedSecurity = readString(inheritedExec.security);
    const localAsk = readString(localExec.ask);
    const inheritedAsk = readString(inheritedExec.ask);
    const localMode = readExecMode(localExec.mode);
    const inheritedMode = readExecMode(inheritedExec.mode);
    // Config conformance intentionally ignores exec-approvals.json runtime/operator state.
    const sandboxMode =
      readString(context.sandbox.mode) ?? readString(context.inheritedSandbox.mode);
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
        modePosture?.inherited === false ||
        (local === undefined && modePosture?.inherited === true);
      pushToolPostureValue({
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
    const localElevated = asNonArrayRecord(context.tools.elevated);
    const inheritedElevated = asNonArrayRecord(context.inheritedTools.elevated);
    const localEnabled = readBoolean(localElevated.enabled);
    const inheritedEnabled = readBoolean(inheritedElevated.enabled);
    const effectiveEnabled =
      inheritedEnabled === false ? false : (localEnabled ?? inheritedEnabled ?? true);
    pushToolPostureValue({
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
        id: `${context.id}-elevated-allow-from-${ocPathSegment(provider)}`,
        kind: "elevatedAllowFrom",
        source: `${inherited ? "oc://openclaw.config/tools" : context.toolsSourceBase}/elevated/allowFrom/${ocPathSegment(provider)}`,
        scope: context.scope,
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        entries: localEntries.length > 0 ? localEntries : inheritedEntries,
        explicit: localEntries.length > 0 || inheritedEntries.length > 0,
      });
    }
    function pushToolPostureValue(
      entry: Omit<PolicyToolPostureEvidence, "id" | "source" | "scope" | "agentId"> & {
        readonly suffix: string;
        readonly sourceSuffix?: string;
        readonly inherited: boolean;
      },
    ): void {
      const { suffix, sourceSuffix = suffix, inherited, value, ...evidence } = entry;
      entries.push({
        id: `${context.id}-${suffix.replaceAll("/", "-")}`,
        source: `${inherited ? "oc://openclaw.config/tools" : context.toolsSourceBase}/${sourceSuffix}`,
        scope: context.scope,
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        ...(value === undefined ? {} : { value }),
        ...evidence,
      });
    }
  }

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
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
