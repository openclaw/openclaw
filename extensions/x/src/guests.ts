import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedXAccount } from "./accounts.js";
import { resolveXGuestSettings } from "./guest-policy.js";
import { openXGuestUsage, XGuestUsageUnavailableError } from "./guest-usage.js";

export function resolveXGuestContainmentError(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const agent = resolveAgentConfig(cfg, agentId);
  if ((agent?.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly) !== true) {
    return `X guest mode requires agents.entries.${agentId}.tools.fs.workspaceOnly=true (or tools.fs.workspaceOnly=true) and the OpenClaw clone as the agent working directory.`;
  }
  const skills = agent?.skills ?? cfg.agents?.defaults?.skills;
  if (!skills || skills.length !== 0) {
    return `X guest mode requires agents.entries.${agentId}.skills=[] so read cannot access external skill directories.`;
  }
  const sandbox = agent?.sandbox;
  const defaults = cfg.agents?.defaults?.sandbox;
  if ((sandbox?.mode ?? defaults?.mode ?? "off") !== "off") {
    return `X guest mode requires agents.entries.${agentId}.sandbox.mode="off" and workspace-only file tools; sandbox mounts can expose files outside the repository.`;
  }
  return undefined;
}

function resolveXGuestReadinessError(
  cfg: OpenClawConfig,
  accountId: string,
  routedAgentId?: string,
): string | undefined {
  // Include the default route and explicit X thread bindings; the router owns account matching.
  const peerIds = new Set([
    "__x_guest_default__",
    ...(cfg.bindings ?? []).flatMap((binding) =>
      binding.match.channel === "x" && binding.match.peer?.kind === "group"
        ? [binding.match.peer.id]
        : [],
    ),
  ]);
  let agentIds: string[];
  try {
    agentIds = routedAgentId
      ? [routedAgentId]
      : [...peerIds].map(
          (id) =>
            resolveChannelInboundRouteEnvelope({
              cfg,
              channel: "x",
              accountId,
              peer: { kind: "group", id },
            }).route.agentId,
        );
  } catch {
    return "X guest mode requires valid X agent bindings. Add a channel-wide X binding and correct any missing target agents.";
  }
  const failures = [...new Set(agentIds)].flatMap(
    (id) => resolveXGuestContainmentError(cfg, id) ?? [],
  );
  return failures.length ? failures.join(" ") : undefined;
}

export async function getXGuestStatus(
  runtime: { state: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir"> },
  account: ResolvedXAccount,
  cfg: OpenClawConfig,
  routedAgentId?: string,
) {
  const { enabled, maxMentionsPerAuthorPerDay } = resolveXGuestSettings(account);
  const blockedReason = enabled
    ? resolveXGuestReadinessError(cfg, account.accountId, routedAgentId)
    : undefined;
  try {
    return {
      enabled,
      maxMentionsPerAuthorPerDay,
      ...(blockedReason ? { blockedReason } : {}),
      ...(await openXGuestUsage(runtime).counts(account.accountId)),
    };
  } catch (error) {
    if (!(error instanceof XGuestUsageUnavailableError)) {
      throw error;
    }
    return {
      enabled,
      maxMentionsPerAuthorPerDay,
      admittedToday: 0,
      rateLimitedToday: 0,
      blockedReason: error.message,
    };
  }
}
