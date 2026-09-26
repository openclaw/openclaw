/**
 * Blocks direct Codex app-server requests that would bypass OpenClaw sandbox or
 * node-exec routing guarantees.
 */
import { tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveSandboxRuntimeStatus, type SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { isCodexRemoteExecPlacementSandbox } from "./config-parsing.js";
import {
  formatCodexNativeNodeExecBlock,
  resolveCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";

const ALLOWED_CONTROL_PLANE_METHODS = new Set([
  "account/rateLimits/read",
  "account/read",
  "app/installed",
  "app/list",
  "app/read",
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/read",
  "config/value/write",
  "environment/add",
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
  "feedback/upload",
  "hooks/list",
  "initialize",
  "marketplace/add",
  "mcpServerStatus/list",
  "model/list",
  "plugin/install",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "skills/list",
  "thread/archive",
  "thread/inject_items",
  "thread/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/rollback",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/steer",
]);

/** Returns a block message when a direct app-server method would bypass OpenClaw execution policy. */
export function resolveCodexAppServerDirectSandboxBypassBlock(params: {
  method: string;
  requestParams?: unknown;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  sandbox?: Pick<SandboxContext, "enabled"> | null;
}): string | undefined {
  const controlPlane = ALLOWED_CONTROL_PLANE_METHODS.has(params.method);
  // Reloading MCP servers can start app-backed processes in the Codex app-server environment.
  if (!controlPlane || params.method === "config/mcpServer/reload") {
    const nodeExecBlock = resolveCodexNativeNodeExecBlock({
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      surface: `app-server method \`${params.method}\``,
    });
    if (nodeExecBlock) {
      return nodeExecBlock;
    }
  }
  if (controlPlane) {
    return undefined;
  }
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const sandboxBlock = resolveCodexNativeSandboxBlock({
    config: params.config,
    sessionKey,
    sandbox: params.sandbox,
    surface: `app-server method \`${params.method}\``,
  });
  if (!sandboxBlock) {
    return undefined;
  }
  if (
    params.method === "thread/start" &&
    hasOpenClawSandboxEnvironmentSelection(params.requestParams)
  ) {
    return undefined;
  }
  return sandboxBlock;
}

/** Resolves the generic native-execution block for sandboxed or node-hosted sessions. */
export function resolveCodexNativeExecutionBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  sandbox?: Pick<SandboxContext, "enabled"> | null;
  sandboxEnvironmentSelected?: boolean;
  surface: string;
}): string | undefined {
  return resolveCodexNativeSandboxBlock(params) ?? resolveCodexNativeNodeExecBlock(params);
}

/** Returns a block message when native Codex execution cannot honor active sandboxing. */
export function resolveCodexNativeSandboxBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  sandbox?: Pick<SandboxContext, "enabled"> | null;
  sandboxEnvironmentSelected?: boolean;
  surface: string;
}): string | undefined {
  if (params.sandboxEnvironmentSelected) {
    return undefined;
  }
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  if (!sessionKey) {
    return undefined;
  }
  if (isCodexRemoteExecPlacementSandbox(params.sandbox) || params.sandbox?.enabled === true) {
    return formatCodexNativeSandboxBlock({ surface: params.surface });
  }
  const sandboxAgentId =
    parseAgentSessionKey(sessionKey)?.agentId ??
    params.agentId ??
    tryResolveDefaultAgentId(params.config ?? {});
  if (!sandboxAgentId) {
    return undefined;
  }
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey,
    agentId: sandboxAgentId,
    classificationAgentId: sandboxAgentId,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }
  return formatCodexNativeSandboxBlock({ surface: params.surface });
}

function hasOpenClawSandboxEnvironmentSelection(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const environments = (value as { environments?: unknown }).environments;
  return (
    Array.isArray(environments) &&
    environments.length > 0 &&
    environments.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const environment = entry as { environmentId?: unknown; cwd?: unknown };
      return (
        typeof environment.environmentId === "string" &&
        environment.environmentId.startsWith("openclaw-sandbox-") &&
        typeof environment.cwd === "string" &&
        environment.cwd.trim().length > 0
      );
    })
  );
}

function formatCodexNativeSandboxBlock(params: { surface: string }): string {
  return [
    `Codex-native ${params.surface} is unavailable because OpenClaw sandboxing is active for this session.`,
    "This mode cannot route execution through the OpenClaw sandbox backend.",
    "Use a normal Codex harness turn, or run an intentionally unsandboxed session.",
  ].join(" ");
}

function resolveCodexNativeNodeExecBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  surface: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  const policy = resolveCodexNativeExecutionPolicy({
    config: params.config,
    sessionKey,
    agentId: params.agentId,
    readRuntimeSessionEntry: Boolean(sessionKey),
  });
  if (policy.nativeToolSurfaceAllowed) {
    return undefined;
  }
  return formatCodexNativeNodeExecBlock({
    surface: params.surface,
    reason: policy.blockReason,
  });
}
