// Line plugin module wires the native approval capability for LINE accounts.
import { markImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalMessagingTargetResolvers,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasLineCredentials } from "./account-helpers.js";
import { listLineAccountIds, resolveDefaultLineAccountId, resolveLineAccount } from "./accounts.js";
import { getLineApprovalApprovers, lineApprovalAuth } from "./approval-auth.js";
import { normalizeLineMessagingTarget } from "./messaging-target.js";

type LineApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;

function isLineApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveLineAccount({
    cfg: params.cfg,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  return account.enabled && hasLineCredentials(account);
}

const lineApprovalTargetResolvers = createNativeApprovalMessagingTargetResolvers({
  channel: "line",
  normalizeTo: normalizeLineMessagingTarget,
});

const lineApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "line",
  defaultForwardingMode: "session",
  isTransportEnabled: isLineApprovalTransportEnabled,
  // Resolved per call, not at module evaluation: reading the account bindings while
  // this module loads breaks every consumer that partially mocks `./accounts.js`.
  listAccountIds: (cfg) => listLineAccountIds(cfg),
  resolveDefaultAccountId: (cfg) => resolveDefaultLineAccountId(cfg),
  normalizeForwardTarget: lineApprovalTargetResolvers.normalizeForwardTarget,
  resolveTurnSourceTarget: lineApprovalTargetResolvers.resolveTurnSourceTarget,
});

/** Whether LINE can deliver native approval cards for one account, for one kind or any. */
export function isLineNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
}): boolean {
  const { approvalKind, ...route } = params;
  const routed = approvalKind
    ? lineApprovalRouteGates.canApprovalPotentiallyRouteToChannel({
        ...route,
        approvalKind,
        nativeSessionOnly: true,
      })
    : lineApprovalRouteGates.canAnyApprovalPotentiallyRouteToChannel({
        ...route,
        nativeSessionOnly: true,
      });
  return routed && getLineApprovalApprovers(route).length > 0;
}

type LineApprovalActorParams = Parameters<
  NonNullable<ChannelApprovalCapability["authorizeActorAction"]>
>[0];

/**
 * Approval actor authorization for LINE.
 *
 * `allowFrom` is LINE's DM allowlist long before it names approvers, and LINE chats used
 * same-chat `/approve` before native cards existed. The approver list therefore restricts
 * a decision only for an approval kind whose cards are on for the account; everywhere
 * else the sender's command authorization keeps deciding, as it did.
 */
export function authorizeLineApprovalActor(
  params: LineApprovalActorParams,
): ReturnType<NonNullable<ChannelApprovalCapability["authorizeActorAction"]>> {
  const { cfg, accountId, approvalKind } = params;
  return isLineNativeApprovalClientEnabled({ cfg, accountId, approvalKind })
    ? lineApprovalAuth.authorizeActorAction(params)
    : markImplicitSameChatApprovalAuthorization({ authorized: true });
}

/** Whether one approval request should reach LINE as a native card. */
export function shouldHandleLineNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: LineApprovalRequest;
}): boolean {
  return (
    lineApprovalRouteGates.shouldHandleApprovalRequest(params) &&
    getLineApprovalApprovers(params).length > 0
  );
}

export function shouldSuppressLocalLineExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isNativeDeliveryEnabled: isLineNativeApprovalClientEnabled,
  });
}

const resolveLineOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "line",
  shouldHandleRequest: shouldHandleLineNativeApprovalRequest,
  resolveTurnSourceTarget: lineApprovalTargetResolvers.resolveTurnSourceTarget,
  resolveSessionTarget: lineApprovalTargetResolvers.resolveSessionTarget,
  normalizeTarget: lineApprovalTargetResolvers.normalizeTarget,
});

const resolveLineApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleLineNativeApprovalRequest,
  resolveApprovers: getLineApprovalApprovers,
  // Approvers are already normalized user ids, the same form the origin resolver
  // yields, so a card sent to the chat that raised the request counts as delivered
  // there instead of drawing a "sent to DMs" notice into that same chat.
  mapApprover: (approver, params) => ({
    to: approver,
    accountId: normalizeOptionalString(params.accountId),
  }),
});

const lineLazyApprovalNativeRuntime = createLazyChannelApprovalNativeRuntimeAdapter({
  capabilityBoundary: true,
  eventKinds: ["exec", "plugin", "system-agent"],
  isConfigured: ({ cfg, accountId }) => isLineNativeApprovalClientEnabled({ cfg, accountId }),
  shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
    shouldHandleLineNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  load: async () => {
    const { lineApprovalNativeRuntime } = await import("./approval-handler.runtime.js");
    return lineApprovalNativeRuntime;
  },
});

// Setup guidance is left out on purpose: core shows it only for a `disabled` surface, and
// LINE never reports one (see `lineApprovalCapability`).
const {
  getExecInitiatingSurfaceState: _nativeClientSurfaceState,
  ...lineNativeApprovalCapability
} = createApproverRestrictedNativeApprovalCapability({
  channel: "line",
  channelLabel: "LINE",
  listAccountIds: (cfg) => listLineAccountIds(cfg),
  hasApprovers: ({ cfg, accountId }) => getLineApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    authorizeLineApprovalActor({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "exec",
    }).authorized,
  isNativeDeliveryEnabled: isLineNativeApprovalClientEnabled,
  // A group postback carries no `userId` (`GroupSource.userId` is documented as
  // message-event only), so a card in a group could not name who tapped it. Routing
  // to approver DMs keeps the tap attributable; the chat that raised the request is
  // told where the approval went.
  resolveNativeDeliveryMode: () => "dm",
  notifyOriginWhenDmOnly: true,
  resolveOriginTarget: resolveLineOriginTarget,
  resolveApproverDmTargets: resolveLineApproverDmTargets,
  nativeRuntime: lineLazyApprovalNativeRuntime,
});

// Forwarding is dropped only for the chats cards already cover: the originating chat (its
// card or routed notice) and the approver DMs. Any other configured target, such as an
// operations group, still gets the text prompt. Core honors this only while the account's
// card handler is running, so a stopped handler never leaves a chat without the prompt.
const shouldSuppressLineForwardingFallback = createNativeApprovalForwardingFallbackSuppressor<
  NonNullable<ReturnType<typeof resolveLineOriginTarget>>
>({
  channel: "line",
  normalizeForwardTarget: lineApprovalTargetResolvers.normalizeForwardTarget,
  // Native targets carry the account; a forwarding target without one matches them
  // under the account the request resolved to.
  resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
    ...forwardingTarget,
    accountId,
  }),
  isSessionRouteEligible: shouldHandleLineNativeApprovalRequest,
  isExplicitTargetEligible: shouldHandleLineNativeApprovalRequest,
  resolveOriginTarget: resolveLineOriginTarget,
  resolveApproverDmTargets: resolveLineApproverDmTargets,
});

export const lineApprovalCapability: ChannelApprovalCapability = {
  ...lineNativeApprovalCapability,
  delivery: {
    ...lineNativeApprovalCapability.delivery,
    shouldSuppressForwardingFallback: shouldSuppressLineForwardingFallback,
  },
  // Cards are added on top of same-chat `/approve`, never in place of it. A `disabled`
  // state would make the Gateway expire a request no other client holds, taking away
  // the prompt LINE chats had before cards existed. Exec reads this same state because
  // the exec-specific hook is left out above.
  getActionAvailabilityState: () => ({ kind: "enabled" }),
  authorizeActorAction: authorizeLineApprovalActor,
};
