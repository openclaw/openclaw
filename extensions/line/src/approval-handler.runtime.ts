// Line plugin module implements the native approval runtime for LINE accounts.
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  type PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveLineAccount } from "./accounts.js";
import { buildLinePendingApprovalCard, type LinePendingApprovalCard } from "./approval-card.js";
import {
  isLineNativeApprovalClientEnabled,
  shouldHandleLineNativeApprovalRequest,
} from "./approval-native.js";
import { normalizeLineMessagingTarget } from "./messaging-target.js";
import { pushFlexMessage, pushMessageLine } from "./send.js";

type LinePreparedTarget = { to: string; accountId?: string };

const log = createSubsystemLogger("line/approvals");

// The view already publishes each decision as the command a non-interactive surface
// would use, so the notice quotes those instead of composing its own syntax. Typed
// `/approve` decides only exec and plugin approvals, so an OpenClaw-change approval is
// sent to the Control UI instead of to commands that would fail.
function buildApprovalCommandFallbackText(view: PendingApprovalView): string {
  const notice = `⚠️ Could not deliver the approval card for ${view.approvalId}.`;
  if (view.approvalKind === "system-agent") {
    return `${notice} Decide it from the Control UI.`;
  }
  return [`${notice} Reply with one of:`, ...view.actions.map(({ command }) => command)].join("\n");
}

async function sendLineApprovalText(params: {
  target: LinePreparedTarget;
  text: string;
  cfg: OpenClawConfig;
  logLabel: string;
}): Promise<void> {
  try {
    await pushMessageLine(params.target.to, params.text, {
      cfg: params.cfg,
      ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
    });
  } catch (error) {
    // Same contract as every other LINE send: a partial-delivery error means LINE
    // already showed this text, so it is not a failure to report.
    if (isChannelPartialDeliveryError(error)) {
      return;
    }
    // This text stands in for a prompt native delivery already suppressed, so an operator
    // needs to see that the approver never received it.
    log.error(`${params.logLabel}: ${String(error)}`);
  }
}

export const lineApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  LinePendingApprovalCard | null,
  LinePreparedTarget,
  LinePreparedTarget,
  never,
  { text: string }
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: ({ cfg, accountId }) => isLineNativeApprovalClientEnabled({ cfg, accountId }),
    shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
      shouldHandleLineNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  },
  presentation: {
    buildPendingPayload: ({ cfg, accountId, view, nowMs }) =>
      buildLinePendingApprovalCard({
        view,
        nowMs,
        channelSecret: resolveLineAccount({ cfg, ...(accountId ? { accountId } : {}) })
          .channelSecret,
      }),
    // LINE cannot edit a delivered message, so the terminal state is a new message
    // the transport sends, the way Signal and iMessage publish theirs.
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalExpiredText({ request, view }) },
    }),
  },
  transport: {
    prepareTarget: ({ accountId, plannedTarget }) => {
      const to = normalizeLineMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const preparedAccountId = normalizeOptionalString(accountId);
      const target: LinePreparedTarget = {
        to,
        ...(preparedAccountId ? { accountId: preparedAccountId } : {}),
      };
      return { dedupeKey: buildChannelApprovalNativeTargetKey({ to }), target };
    },
    deliverPending: async ({ cfg, preparedTarget, pendingPayload, view }) => {
      if (!pendingPayload) {
        // Native delivery already suppressed the local prompt, so an undrawable card
        // still owes the approver a way to decide.
        await sendLineApprovalText({
          target: preparedTarget,
          cfg,
          text: buildApprovalCommandFallbackText(view),
          logLabel: "line approvals: command fallback failed",
        });
        return null;
      }
      try {
        await pushFlexMessage(preparedTarget.to, pendingPayload.altText, pendingPayload.bubble, {
          cfg,
          ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
        });
      } catch (error) {
        // LINE accepted the card and only its receipt was unreadable. The card is on the
        // approver's screen, so it is tracked like any delivered card: the outcome still
        // gets published, and the origin is not told the request went undelivered.
        if (!isChannelPartialDeliveryError(error)) {
          throw error;
        }
      }
      return { ...preparedTarget };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await sendLineApprovalText({
        target: entry,
        cfg,
        text: payload.text,
        logLabel: "line approvals: terminal notice failed",
      });
    },
  },
  observe: {
    onDeliveryError: ({ accountId, cfg, error, plannedTarget, request, pendingPayload, view }) => {
      log.error(`line approvals: failed to deliver request ${request.id}: ${String(error)}`);
      const to = normalizeLineMessagingTarget(plannedTarget.target.to);
      if (!to || !pendingPayload) {
        return;
      }
      const preparedAccountId = normalizeOptionalString(accountId);
      void sendLineApprovalText({
        target: { to, ...(preparedAccountId ? { accountId: preparedAccountId } : {}) },
        cfg,
        text: buildApprovalCommandFallbackText(view),
        logLabel: "line approvals: delivery fallback failed",
      });
    },
  },
});
