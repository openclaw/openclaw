import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { expandToolGroups } from "../tool-policy.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxToolPolicyForAgent } from "./tool-policy.js";
import type { SandboxConfig, SandboxToolPolicyResolved } from "./types.js";

function isPrivateModeSandboxForced(cfg?: OpenClawConfig): boolean {
  if (cfg?.privateMode?.enabled !== true) {
    return false;
  }
  const execution = cfg.privateMode.execution;
  return execution?.sandboxMode === "all" || execution?.blockHostExec === true;
}

function shouldSandboxSession(cfg: SandboxConfig, sessionKey: string, mainSessionKey: string) {
  if (cfg.mode === "off") {
    return false;
  }
  if (cfg.mode === "all") {
    return true;
  }
  return sessionKey.trim() !== mainSessionKey.trim();
}

function resolveMainSessionKeyForSandbox(params: {
  cfg?: OpenClawConfig;
  agentId: string;
}): string {
  if (params.cfg?.session?.scope === "global") {
    return "global";
  }
  return resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
}

function resolveComparableSessionKeyForSandbox(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}

export function resolveSandboxRuntimeStatus(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
}): {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
  mode: SandboxConfig["mode"];
  forcedByPrivateMode: boolean;
  sandboxed: boolean;
  toolPolicy: SandboxToolPolicyResolved;
} {
  const sessionKey = params.sessionKey?.trim() ?? "";
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: params.cfg,
  });
  const cfg = params.cfg;
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
  const forcedByPrivateMode = isPrivateModeSandboxForced(cfg);
  const effectiveMode: SandboxConfig["mode"] = forcedByPrivateMode ? "all" : sandboxCfg.mode;
  const mainSessionKey = resolveMainSessionKeyForSandbox({ cfg, agentId });
  const sandboxed = sessionKey
    ? shouldSandboxSession(
        { ...sandboxCfg, mode: effectiveMode },
        resolveComparableSessionKeyForSandbox({ cfg, agentId, sessionKey }),
        mainSessionKey,
      )
    : false;
  return {
    agentId,
    sessionKey,
    mainSessionKey,
    mode: effectiveMode,
    forcedByPrivateMode,
    sandboxed,
    toolPolicy: resolveSandboxToolPolicyForAgent(cfg, agentId),
  };
}

export function formatSandboxToolPolicyBlockedMessage(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  toolName: string;
}): string | undefined {
  const tool = params.toolName.trim().toLowerCase();
  if (!tool) {
    return undefined;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }

  const deny = new Set(expandToolGroups(runtime.toolPolicy.deny));
  const allow = expandToolGroups(runtime.toolPolicy.allow);
  const allowSet = allow.length > 0 ? new Set(allow) : null;
  const blockedByDeny = deny.has(tool);
  const blockedByAllow = allowSet ? !allowSet.has(tool) : false;
  if (!blockedByDeny && !blockedByAllow) {
    return undefined;
  }

  const reasons: string[] = [];
  const fixes: string[] = [];
  if (blockedByDeny) {
    reasons.push("deny list");
    fixes.push(`Remove "${tool}" from ${runtime.toolPolicy.sources.deny.key}.`);
  }
  if (blockedByAllow) {
    reasons.push("allow list");
    fixes.push(
      `Add "${tool}" to ${runtime.toolPolicy.sources.allow.key} (or set it to [] to allow all).`,
    );
  }

  const lines: string[] = [];
  lines.push(`Tool "${tool}" blocked by sandbox tool policy (mode=${runtime.mode}).`);
  lines.push(`Session: ${runtime.sessionKey || "(unknown)"}`);
  if (runtime.forcedByPrivateMode) {
    lines.push("Sandboxing is being forced by privateMode execution settings.");
  }
  lines.push(`Reason: ${reasons.join(" + ")}`);
  lines.push("Fix:");
  if (runtime.forcedByPrivateMode) {
    lines.push(`- privateMode.execution.sandboxMode: remove "all"`);
    lines.push(`- privateMode.execution.blockHostExec: set false`);
    lines.push(`- Or disable privateMode entirely`);
  } else {
    lines.push(`- agents.defaults.sandbox.mode=off (disable sandbox)`);
  }
  for (const fix of fixes) {
    lines.push(`- ${fix}`);
  }
  if (runtime.mode === "non-main" && !runtime.forcedByPrivateMode) {
    lines.push(`- Use main session key (direct): ${runtime.mainSessionKey}`);
  }
  lines.push(
    `- See: ${formatCliCommand(`openclaw sandbox explain --session ${runtime.sessionKey}`)}`,
  );

  return lines.join("\n");
}
