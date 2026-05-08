import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_AGENTKIT_CLI_COMMAND = "agentkit";
export const DEFAULT_AGENTKIT_HITL_SEVERITY = "warning";
export const DEFAULT_AGENTKIT_HITL_TIMEOUT_MS = 120_000;
export const DEFAULT_AGENTKIT_HITL_GRANT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_AGENTKIT_HITL_MODE = "delegation";
export const DEFAULT_AGENTKIT_WORLD_APPROVAL_ACTION_PREFIX = "openclaw-approval";

type UnknownRecord = Record<string, unknown>;
type AgentkitHitlSeverity = "info" | "warning" | "critical";
type AgentkitHitlGrantScope = "session" | "agent";
export type AgentkitHitlMode = "delegation" | "human-approval";
export type AgentkitHumanApprovalProvider = "hosted" | "custom";
type AgentkitHumanApprovalEnvironment = "production" | "staging";

export type AgentkitPluginConfig = {
  walletAddress?: string;
  cli: {
    command: string;
    args: string[];
  };
  hitl: {
    enabled: boolean;
    mode: AgentkitHitlMode;
    resourceUrl: string | null;
    protectedTools: string[];
    severity: AgentkitHitlSeverity;
    timeoutMs: number;
    grantScope: AgentkitHitlGrantScope;
    grantTtlMs: number;
    grantsFile: string | null;
    humanApproval: {
      provider: AgentkitHumanApprovalProvider;
      brokerUrl: string | null;
      appId: string | null;
      rpId: string | null;
      signingKey: string | null;
      signingKeyEnvVar: string | null;
      environment: AgentkitHumanApprovalEnvironment;
      actionPrefix: string;
    };
  };
};

export type AgentkitPluginEntryState = {
  configured: boolean;
  explicitlyEnabled: boolean;
  explicitlyDisabled: boolean;
  effectiveEnabled: boolean;
};

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function asFinitePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(items));
}

function resolveHitlSeverity(value: unknown): AgentkitHitlSeverity {
  return value === "info" || value === "critical" || value === "warning"
    ? value
    : DEFAULT_AGENTKIT_HITL_SEVERITY;
}

function resolveGrantScope(value: unknown): AgentkitHitlGrantScope {
  return value === "agent" ? "agent" : "session";
}

function resolveHitlMode(value: unknown): AgentkitHitlMode {
  return value === "human-approval" ? "human-approval" : DEFAULT_AGENTKIT_HITL_MODE;
}

function resolveHumanApprovalEnvironment(value: unknown): AgentkitHumanApprovalEnvironment {
  return value === "staging" ? "staging" : "production";
}

function hasCustomHumanApprovalCredentials(value: UnknownRecord): boolean {
  return (
    normalizeOptionalString(value.appId) != null ||
    normalizeOptionalString(value.rpId) != null ||
    normalizeOptionalString(value.signingKey) != null ||
    normalizeOptionalString(value.signingKeyEnvVar) != null
  );
}

function resolveHumanApprovalProvider(
  value: unknown,
  humanApproval: UnknownRecord,
): AgentkitHumanApprovalProvider {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === "hosted" || normalized === "custom") {
    return normalized;
  }
  return hasCustomHumanApprovalCredentials(humanApproval) ? "custom" : "hosted";
}

export function resolveAgentkitPluginConfig(raw: unknown): AgentkitPluginConfig {
  const pluginConfig = asRecord(raw) ?? {};
  const cli = asRecord(pluginConfig.cli) ?? {};
  const hitl = asRecord(pluginConfig.hitl) ?? {};
  const humanApproval = asRecord(hitl.humanApproval) ?? {};
  const humanApprovalProvider = resolveHumanApprovalProvider(humanApproval.provider, humanApproval);
  return {
    walletAddress: normalizeOptionalString(pluginConfig.walletAddress),
    cli: {
      command: normalizeOptionalString(cli.command) ?? DEFAULT_AGENTKIT_CLI_COMMAND,
      args: asStringArray(cli.args),
    },
    hitl: {
      enabled: hitl.enabled === true,
      mode: resolveHitlMode(hitl.mode),
      resourceUrl: normalizeOptionalString(hitl.resourceUrl) ?? null,
      protectedTools: asStringArray(hitl.protectedTools),
      severity: resolveHitlSeverity(hitl.severity),
      timeoutMs: asFinitePositiveInteger(hitl.timeoutMs, DEFAULT_AGENTKIT_HITL_TIMEOUT_MS),
      grantScope: resolveGrantScope(hitl.grantScope),
      grantTtlMs: asFinitePositiveInteger(hitl.grantTtlMs, DEFAULT_AGENTKIT_HITL_GRANT_TTL_MS),
      grantsFile: normalizeOptionalString(hitl.grantsFile) ?? null,
      humanApproval: {
        provider: humanApprovalProvider,
        brokerUrl: normalizeOptionalString(humanApproval.brokerUrl) ?? null,
        appId: normalizeOptionalString(humanApproval.appId) ?? null,
        rpId: normalizeOptionalString(humanApproval.rpId) ?? null,
        signingKey: normalizeOptionalString(humanApproval.signingKey) ?? null,
        signingKeyEnvVar: normalizeOptionalString(humanApproval.signingKeyEnvVar) ?? null,
        environment: resolveHumanApprovalEnvironment(humanApproval.environment),
        actionPrefix:
          normalizeOptionalString(humanApproval.actionPrefix) ??
          DEFAULT_AGENTKIT_WORLD_APPROVAL_ACTION_PREFIX,
      },
    },
  };
}

export function resolveAgentkitEntryState(appConfig: OpenClawConfig): AgentkitPluginEntryState {
  const entry = asRecord(appConfig.plugins?.entries?.agentkit);
  const explicitlyEnabled = entry?.enabled === true;
  const explicitlyDisabled = entry?.enabled === false;
  return {
    configured: entry != null,
    explicitlyEnabled,
    explicitlyDisabled,
    // AgentKit is bundled and opt-in, so only explicit enablement activates it.
    effectiveEnabled: explicitlyEnabled,
  };
}

export function resolveConfiguredAgentkitPluginConfig(
  appConfig: OpenClawConfig,
): AgentkitPluginConfig {
  const entry = asRecord(appConfig.plugins?.entries?.agentkit);
  return resolveAgentkitPluginConfig(entry?.config);
}
