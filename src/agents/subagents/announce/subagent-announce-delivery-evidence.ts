import type { ChannelId } from "../../../channels/plugins/channel-id.types.js";
import { getLoadedChannelPluginEntryById } from "../../../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  matchSourceDeliveryTargetWithPlugin,
  type SourceDeliveryMessageToolTarget,
  type SourceDeliveryTarget,
} from "../../../infra/outbound/source-delivery-target-match.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { tryResolveSubagentRequesterAgentId } from "./subagent-announce-delivery.runtime.js";

const MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS = 10_000;

async function resolveEquivalentMessagingToolTarget(
  params: {
    cfg: OpenClawConfig;
    requesterSessionKey: string;
    requesterAgentId?: string;
    signal?: AbortSignal;
  },
  target: MessagingToolDeliveryTarget,
  expected: SourceDeliveryTarget,
): Promise<string | undefined> {
  const agentId = tryResolveSubagentRequesterAgentId(
    params.cfg,
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  const channel = normalizeMessageChannel(expected.channel);
  const provider = target.provider?.trim().toLowerCase();
  if (
    !channel ||
    !agentId ||
    !target.to?.trim() ||
    (provider && provider !== "message" && provider !== channel) ||
    (expected.accountId && target.accountId !== expected.accountId)
  ) {
    return undefined;
  }
  params.signal?.throwIfAborted();
  const accountId = target.accountId ?? expected.accountId ?? null;
  const resolver =
    getLoadedChannelPluginEntryById(channel)?.plugin.messaging?.resolveOutboundSessionRoute;
  if (!resolver) {
    return undefined;
  }
  const route = await resolver({
    cfg: params.cfg,
    agentId,
    accountId,
    target: target.to,
    threadId: target.threadId ?? null,
    signal: params.signal,
  });
  if (!route || route.recipientSessionExact !== true) {
    return undefined;
  }
  const bindingRoute = resolveAgentRoute({
    cfg: params.cfg,
    // SAFETY: the registered plugin lookup above returned this channel's route resolver.
    channel: channel as ChannelId,
    defaultAgentId: agentId,
    accountId,
    peer: route.peer,
  });
  return normalizeAgentId(bindingRoute.agentId) === normalizeAgentId(agentId)
    ? route.to
    : undefined;
}

type MessagingToolDeliveryTarget = SourceDeliveryMessageToolTarget;

function sourceDeliveryTargetsMatch(
  target: MessagingToolDeliveryTarget,
  delivery: SourceDeliveryTarget,
): boolean {
  const channel = normalizeMessageChannel(delivery.channel);
  return channel
    ? matchSourceDeliveryTargetWithPlugin(
        target,
        delivery,
        getLoadedChannelPluginEntryById(channel)?.plugin,
      )
    : false;
}

type MessagingToolDeliveryMatchOptions = {
  requireFinalReply?: boolean;
  signal?: AbortSignal;
  /** Resolve provider-native delivery identities to the configured source target. */
  resolveEquivalentTarget?: (
    target: MessagingToolDeliveryTarget,
    deliveryTarget: SourceDeliveryTarget,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
};

export type MessagingToolDeliveryResult = {
  didDeliverSourceReplyViaMessageTool?: unknown;
  didSendViaMessagingTool?: unknown;
  messagingToolSentTargets?: unknown;
  messagingToolSourceReplyPayloads?: unknown;
};

export async function hasMessagingToolDeliveryToSource(
  result: MessagingToolDeliveryResult,
  deliveryTarget: SourceDeliveryTarget,
  options?: MessagingToolDeliveryMatchOptions,
): Promise<boolean> {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets: MessagingToolDeliveryTarget[] = [];
  const equivalentTargetCandidates: MessagingToolDeliveryTarget[] = [];
  for (const target of targets) {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !deliveryTarget.channel ||
      !deliveryTarget.to
    ) {
      continue;
    }
    // SAFETY: the preceding guards establish the object shape required by this receipt record.
    const record = target as MessagingToolDeliveryTarget;
    // Older source receipts omit `to`; explicit off-target sends must never satisfy it.
    const sourceTarget =
      typeof record.to === "string" && record.to.trim()
        ? record
        : { ...record, to: deliveryTarget.to };
    if (sourceDeliveryTargetsMatch(sourceTarget, deliveryTarget)) {
      sourceTargets.push(sourceTarget);
      continue;
    }
    if (!options?.resolveEquivalentTarget || !record.to?.trim()) {
      continue;
    }
    // The existing exact-match path preserves legacy receipts, but a provider
    // lookup must never turn a missing account into a wildcard.
    if (deliveryTarget.accountId && record.accountId !== deliveryTarget.accountId) {
      continue;
    }
    equivalentTargetCandidates.push(sourceTarget);
  }

  const hasFinalSourceDelivery = () => {
    const hasCommittedSourceDelivery =
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      (hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0);
    // Only current-source final markers count; another target's final cannot
    // turn a source progress update into the owed requester reply.
    return (
      hasCommittedSourceDelivery &&
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: sourceTargets,
        messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
      }) !== false
    );
  };
  const hasSourceDelivery = () => {
    if (
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      hasUnaccountedMessagingToolAggregateEvidence({ ...result, didSendViaMessagingTool: false })
    ) {
      return true;
    }

    if (targets.length === 0 || !deliveryTarget.channel || !deliveryTarget.to) {
      return hasMessagingToolDeliveryEvidence(result);
    }

    return hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0;
  };

  // Exact source receipts are already authoritative. Evaluate them before any
  // provider-native lookup, so a slow or stuck unrelated lookup cannot erase a
  // delivery that was confirmed by the gateway result itself.
  if (options?.requireFinalReply ? hasFinalSourceDelivery() : hasSourceDelivery()) {
    return true;
  }

  const resolveEquivalentTarget = options?.resolveEquivalentTarget;
  if (resolveEquivalentTarget && equivalentTargetCandidates.length > 0) {
    // Provider-native IDs (for example Slack's D… DM channels) can represent
    // the configured source user without being textually equal. Resolve all
    // candidates concurrently: one unrelated lookup may stall, but a source
    // match that completes must still be allowed to settle the announcement.
    const hasResolvedSourceDelivery = await Promise.any(
      equivalentTargetCandidates.map(async (sourceTarget) => {
        try {
          const equivalentTarget = await resolveEquivalentTarget(
            sourceTarget,
            deliveryTarget,
            options.signal,
          );
          if (
            equivalentTarget &&
            sourceDeliveryTargetsMatch({ ...sourceTarget, to: equivalentTarget }, deliveryTarget)
          ) {
            sourceTargets.push({ ...sourceTarget, to: equivalentTarget });
            if (options.requireFinalReply ? hasFinalSourceDelivery() : hasSourceDelivery()) {
              return true;
            }
          }
        } catch {
          // Keep the completion owed when the provider cannot verify the recipient.
        }
        throw new Error("provider-native source delivery was not verified");
      }),
    ).then(
      () => true,
      () => false,
    );
    if (hasResolvedSourceDelivery) {
      return true;
    }
  }

  if (options?.requireFinalReply) {
    return hasFinalSourceDelivery();
  }
  return hasSourceDelivery();
}

export async function resolveMessagingToolDeliveryEvidence(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  result: MessagingToolDeliveryResult;
  deliveryTarget: SourceDeliveryTarget;
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveEquivalentTarget?: MessagingToolDeliveryMatchOptions["resolveEquivalentTarget"];
}): Promise<{ hasFinalMessagingToolDelivery: boolean; hasMessagingToolDelivery: boolean }> {
  const verificationTimeoutMs = Math.min(
    Math.max(params.timeoutMs ?? MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS, 1),
    MAX_MESSAGING_TOOL_DELIVERY_VERIFICATION_TIMEOUT_MS,
  );
  const verificationDeadline = new AbortController();
  const timer = setTimeout(
    () => verificationDeadline.abort(new Error("messaging tool delivery verification timed out")),
    verificationTimeoutMs,
  );
  timer.unref?.();
  const signal = params.signal
    ? AbortSignal.any([params.signal, verificationDeadline.signal])
    : verificationDeadline.signal;
  const noDelivery: {
    hasFinalMessagingToolDelivery: boolean;
    hasMessagingToolDelivery: boolean;
  } = {
    hasFinalMessagingToolDelivery: false,
    hasMessagingToolDelivery: false,
  };
  let confirmedMessagingToolDelivery = false;
  const verificationAborted = new Promise<typeof noDelivery>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({
        ...noDelivery,
        // A source progress receipt is independently confirmed even when
        // final-reply verification is still waiting on another target.
        hasMessagingToolDelivery: confirmedMessagingToolDelivery,
      });
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    const verification = (async () => {
      const equivalentTargetResolver =
        params.resolveEquivalentTarget ??
        ((
          target: MessagingToolDeliveryTarget,
          deliveryTarget: SourceDeliveryTarget,
          callbackSignal?: AbortSignal,
        ) =>
          resolveEquivalentMessagingToolTarget(
            {
              cfg: params.cfg,
              requesterSessionKey: params.requesterSessionKey,
              requesterAgentId: params.requesterAgentId,
              signal: callbackSignal ?? signal,
            },
            target,
            deliveryTarget,
          ));
      const matchOptions = { resolveEquivalentTarget: equivalentTargetResolver, signal };
      // Capture exact, aggregate, or provider-resolved progress before final
      // verification can stall. The resolver is needed here so a native
      // progress target can be credited independently of final verification.
      confirmedMessagingToolDelivery = await hasMessagingToolDeliveryToSource(
        params.result,
        params.deliveryTarget,
        matchOptions,
      );
      const hasFinalMessagingToolDelivery = await hasMessagingToolDeliveryToSource(
        params.result,
        params.deliveryTarget,
        { ...matchOptions, requireFinalReply: true },
      );
      return {
        hasFinalMessagingToolDelivery,
        hasMessagingToolDelivery:
          hasFinalMessagingToolDelivery ||
          confirmedMessagingToolDelivery ||
          (await hasMessagingToolDeliveryToSource(
            params.result,
            params.deliveryTarget,
            matchOptions,
          )),
      };
    })();
    // The provider callback is cooperative, but completion settlement must not
    // inherit that implementation detail. Abort the callback when possible and
    // independently release the completion owner when it ignores the signal.
    return await Promise.race([verification, verificationAborted]);
  } finally {
    clearTimeout(timer);
    // Verification owns this controller so a successful match also cancels
    // any concurrent provider lookups that lost the race.
    verificationDeadline.abort();
  }
}
