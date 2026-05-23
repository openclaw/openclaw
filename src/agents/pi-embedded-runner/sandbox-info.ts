import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../bash-tools.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import type { resolveSandboxContext } from "../sandbox.js";
import type { EmbeddedFullAccessBlockedReason, EmbeddedSandboxInfo } from "./types.js";

type EmbeddedFullAccessExecPolicy = Pick<ExecToolDefaults, "mode" | "security" | "ask">;
type EmbeddedFullAccessHostPolicy = Pick<ExecToolDefaults, "security" | "ask">;
type EmbeddedSandboxInfoExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "mode" | "security" | "ask" | "node"
>;

function execPolicyBlocksFullAccess(params: {
  execPolicy?: EmbeddedFullAccessExecPolicy;
  hostPolicy?: EmbeddedFullAccessHostPolicy;
}): boolean {
  return (
    (params.execPolicy?.mode !== undefined && params.execPolicy.mode !== "full") ||
    (params.execPolicy?.security !== undefined && params.execPolicy.security !== "full") ||
    (params.execPolicy?.ask !== undefined && params.execPolicy.ask !== "off") ||
    (params.hostPolicy?.security !== undefined && params.hostPolicy.security !== "full") ||
    (params.hostPolicy?.ask !== undefined && params.hostPolicy.ask !== "off")
  );
}

export function resolveEmbeddedFullAccessState(params: {
  execElevated?: ExecElevatedDefaults;
  execPolicy?: EmbeddedFullAccessExecPolicy;
  hostPolicy?: EmbeddedFullAccessHostPolicy;
}): {
  available: boolean;
  blockedReason?: EmbeddedFullAccessBlockedReason;
} {
  if (execPolicyBlocksFullAccess(params)) {
    return {
      available: false,
      blockedReason: "host-policy",
    };
  }
  if (params.execElevated?.fullAccessAvailable === true) {
    return { available: true };
  }
  if (params.execElevated?.fullAccessAvailable === false) {
    return {
      available: false,
      blockedReason: params.execElevated.fullAccessBlockedReason ?? "host-policy",
    };
  }
  if (!params.execElevated?.enabled || !params.execElevated.allowed) {
    return {
      available: false,
      blockedReason: "host-policy",
    };
  }
  return { available: true };
}

function buildSessionEntryForExecOverrides(
  execOverrides?: EmbeddedSandboxInfoExecOverrides,
): SessionEntry | undefined {
  if (
    execOverrides?.host === undefined &&
    execOverrides?.mode === undefined &&
    execOverrides?.security === undefined &&
    execOverrides?.ask === undefined &&
    execOverrides?.node === undefined
  ) {
    return undefined;
  }
  return {
    sessionId: "embedded-sandbox-info",
    updatedAt: 0,
    ...(execOverrides.host !== undefined ? { execHost: execOverrides.host } : {}),
    ...(execOverrides.mode !== undefined ? { execMode: execOverrides.mode } : {}),
    ...(execOverrides.security !== undefined ? { execSecurity: execOverrides.security } : {}),
    ...(execOverrides.ask !== undefined ? { execAsk: execOverrides.ask } : {}),
    ...(execOverrides.node !== undefined ? { execNode: execOverrides.node } : {}),
  };
}

export function resolveEmbeddedSandboxInfoExecPolicy(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
  execOverrides?: EmbeddedSandboxInfoExecOverrides;
}): EmbeddedFullAccessExecPolicy {
  const defaults = resolveExecDefaults({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sandboxAvailable: params.sandboxAvailable,
    elevatedRequested: true,
    sessionEntry: buildSessionEntryForExecOverrides(params.execOverrides),
  });
  return {
    mode: defaults.mode,
    security: defaults.security,
    ask: defaults.ask,
  };
}

export function buildEmbeddedSandboxInfo(
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>,
  execElevated?: ExecElevatedDefaults,
  execPolicy?: EmbeddedFullAccessExecPolicy,
  hostPolicy?: EmbeddedFullAccessHostPolicy,
): EmbeddedSandboxInfo | undefined {
  if (!sandbox?.enabled) {
    return undefined;
  }
  const elevatedConfigured = execElevated?.enabled === true;
  const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
  const fullAccess = resolveEmbeddedFullAccessState({
    execElevated,
    execPolicy,
    hostPolicy,
  });
  return {
    enabled: true,
    workspaceDir: sandbox.workspaceDir,
    containerWorkspaceDir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
    agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : undefined,
    browserBridgeUrl: sandbox.browser?.bridgeUrl,
    hostBrowserAllowed: sandbox.browserAllowHostControl,
    ...(elevatedConfigured
      ? {
          elevated: {
            allowed: elevatedAllowed,
            defaultLevel: execElevated?.defaultLevel ?? "off",
            fullAccessAvailable: fullAccess.available,
            ...(fullAccess.blockedReason
              ? { fullAccessBlockedReason: fullAccess.blockedReason }
              : {}),
          },
        }
      : {}),
  };
}
