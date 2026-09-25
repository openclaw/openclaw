/**
 * Retires chat takeovers left by older agent-started subagent spawns: a system-created
 * subagent binding on the requester's own conversation. Bindings a user created
 * (`/subagents spawn --thread`, `/acp`) and new child threads are left alone.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveInboundConversationResolution } from "../../../channels/conversation-resolution.js";
import { resolveThreadBindingAccountId } from "../../../channels/thread-bindings-policy.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getSessionBindingService,
  onSessionBindingAdapterRegistered,
  type SessionBindingService,
} from "../../../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const AGENT_SPAWN_TAKEOVER_UNBIND_REASON = "agent-spawn-takeover-retired";
const log = createSubsystemLogger("agents/subagent-takeover-sweep");

async function retireAgentSpawnTakeoverBindings(params: {
  cfg: OpenClawConfig;
  runs: Iterable<SubagentRunRecord>;
  bindingService: Pick<SessionBindingService, "listBySession" | "unbind">;
  /** Limit the sweep to one channel account, e.g. the adapter that just registered. */
  scope?: { channel: string; accountId: string };
}): Promise<number> {
  const scopeChannel = normalizeOptionalLowercaseString(params.scope?.channel);
  const checkedChildren = new Set<string>();
  let retired = 0;
  for (const run of params.runs) {
    const origin = run.requesterOrigin;
    const channel = normalizeOptionalLowercaseString(origin?.channel);
    if (!origin || !channel || checkedChildren.has(run.childSessionKey)) {
      continue;
    }
    if (scopeChannel && channel !== scopeChannel) {
      continue;
    }
    checkedChildren.add(run.childSessionKey);
    const accountId = resolveThreadBindingAccountId({
      cfg: params.cfg,
      channel,
      accountId: origin.accountId,
    });
    if (params.scope && accountId !== params.scope.accountId) {
      continue;
    }
    const requesterConversation = resolveInboundConversationResolution({
      cfg: params.cfg,
      channel,
      accountId,
      to: origin.to,
      threadId: origin.threadId,
    });
    if (!requesterConversation?.conversationId) {
      continue;
    }
    for (const binding of params.bindingService.listBySession(run.childSessionKey)) {
      const takeover =
        binding.targetKind === "subagent" &&
        binding.metadata?.boundBy === "system" &&
        binding.conversation.channel === channel &&
        binding.conversation.accountId === accountId &&
        binding.conversation.conversationId === requesterConversation.conversationId;
      if (!takeover) {
        continue;
      }
      const removed = await params.bindingService.unbind({
        bindingId: binding.bindingId,
        scope: { channel, accountId },
        reason: AGENT_SPAWN_TAKEOVER_UNBIND_REASON,
      });
      retired += removed.length;
    }
  }
  return retired;
}

/**
 * Sweeps once for bindings readable now, then again whenever a channel account's binding
 * adapter registers, because each channel loads its persisted bindings when it starts.
 */
export function startAgentSpawnTakeoverSweep(params: {
  runs: Pick<ReadonlyMap<string, SubagentRunRecord>, "values">;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): void {
  const sweep = (scope?: { channel: string; accountId: string }) => {
    retireAgentSpawnTakeoverBindings({
      cfg: getRuntimeConfig(),
      runs: [...params.runs.values()],
      bindingService: getSessionBindingService(),
      scope,
    })
      .then((retired) => {
        if (retired > 0) {
          log.info(`retired ${retired} chat takeover binding(s) left by agent-started subagents`);
        }
      })
      .catch((error: unknown) => {
        params.warn("agent-spawn takeover binding sweep failed", { error: String(error) });
      });
  };
  onSessionBindingAdapterRegistered("agents/subagent-takeover-sweep", sweep);
  sweep();
}
