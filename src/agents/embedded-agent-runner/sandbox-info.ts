import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../bash-tools.js";
import { withPreparedExecDefaults } from "../exec-defaults.preparation.js";
import type { resolveSandboxContext } from "../sandbox.js";
import {
  withPreparedToolConstruction,
  type ToolConstructionPreparationOptions,
} from "../tool-construction-preparation.js";
import type { EmbeddedFullAccessBlockedReason, EmbeddedSandboxInfo } from "./types.js";

type EmbeddedFullAccessExecPolicy = Pick<ExecToolDefaults, "mode" | "security" | "ask">;
type EmbeddedFullAccessHostPolicy = Pick<ExecToolDefaults, "security" | "ask">;
type EmbeddedSandboxInfoExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "security" | "ask" | "node"
>;

/** Computes whether elevated exec can provide full host access for an embedded turn. */
export function resolveEmbeddedFullAccessState(params: {
  execElevated?: ExecElevatedDefaults;
  execPolicy?: EmbeddedFullAccessExecPolicy;
  hostPolicy?: EmbeddedFullAccessHostPolicy;
}): {
  available: boolean;
  blockedReason?: EmbeddedFullAccessBlockedReason;
} {
  const blockedByPolicy =
    (params.execPolicy?.mode !== undefined && params.execPolicy.mode !== "full") ||
    (params.execPolicy?.security !== undefined && params.execPolicy.security !== "full") ||
    params.execPolicy?.ask === "always" ||
    (params.hostPolicy?.security !== undefined && params.hostPolicy.security !== "full") ||
    params.hostPolicy?.ask === "always";
  // Explicit exec/host policy wins over elevated availability. A configured elevated backend
  // must not bypass ask/security restrictions chosen for this agent or session.
  const available =
    !blockedByPolicy &&
    (params.execElevated?.fullAccessAvailable ??
      Boolean(params.execElevated?.enabled && params.execElevated.allowed));
  return available
    ? { available }
    : {
        available,
        blockedReason:
          !blockedByPolicy && params.execElevated?.fullAccessAvailable === false
            ? (params.execElevated.fullAccessBlockedReason ?? "host-policy")
            : "host-policy",
      };
}

export async function resolveEmbeddedSandboxInfoExecPolicy(
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    permissionMode?: SessionEntry["permissionMode"];
    sandboxAvailable?: boolean;
    execOverrides?: EmbeddedSandboxInfoExecOverrides;
  },
  source: ToolConstructionPreparationOptions,
): Promise<EmbeddedFullAccessExecPolicy> {
  return withPreparedToolConstruction(params.config, source, async (shared) =>
    withPreparedExecDefaults(
      {
        cfg: shared.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionEntry: params.permissionMode ? { permissionMode: params.permissionMode } : undefined,
        sandboxAvailable: params.sandboxAvailable,
        elevatedRequested: true,
        execOverrides: params.execOverrides,
      },
      shared,
      async (defaults) => ({ mode: defaults.mode, security: defaults.security, ask: defaults.ask }),
    ),
  );
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
  const elevatedAllowed =
    !sandbox.required && Boolean(execElevated?.enabled && execElevated.allowed);
  const fullAccess = sandbox.required
    ? { available: false, blockedReason: "host-policy" as const }
    : resolveEmbeddedFullAccessState({
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
            defaultLevel: sandbox.required ? "off" : (execElevated?.defaultLevel ?? "off"),
            fullAccessAvailable: fullAccess.available,
            ...(fullAccess.blockedReason
              ? { fullAccessBlockedReason: fullAccess.blockedReason }
              : {}),
          },
        }
      : {}),
  };
}
