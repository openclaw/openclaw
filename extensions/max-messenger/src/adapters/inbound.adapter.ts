import type { MaxEvent, MaxUpdateType } from "../types.js";

/**
 * Phase 1A inbound dispatch skeleton.
 *
 * The supervisor (Phase 1B per docs/max-plugin/plan.md §6.1.6) will push
 * normalized `MaxEvent` instances into `dispatchInboundEvent`. Today this
 * function only owns the switch shape — every branch logs and returns so the
 * surface compiles, but no agent reply is produced and no transport callbacks
 * are wired.
 *
 * Phase 1B replaces the `message_created` branch with a call into
 * `handleMaxInbound` → `dispatchInboundReplyWithBase`. Other branches (callback
 * buttons, attachments, membership) light up in Phases 3-4.
 */
export type MaxInboundContext = {
  accountId: string;
  log?: { info?: (msg: string) => void };
};

export type MaxInboundDispatchResult = "handled" | "ignored" | "deferred";

const KNOWN_UPDATE_TYPES: ReadonlySet<MaxUpdateType> = new Set<MaxUpdateType>([
  "bot_started",
  "message_created",
  "message_edited",
  "message_removed",
  "message_callback",
  "bot_added",
  "bot_removed",
  "user_added",
  "user_removed",
  "chat_title_changed",
]);

export function dispatchInboundEvent(
  ctx: MaxInboundContext,
  event: MaxEvent,
): MaxInboundDispatchResult {
  if (!KNOWN_UPDATE_TYPES.has(event.update_type)) {
    ctx.log?.info?.(
      `[max-messenger:${ctx.accountId}] inbound dispatch: unknown update_type=${event.update_type} (Phase 1A scaffolding)`,
    );
    return "ignored";
  }

  switch (event.update_type) {
    case "message_created":
      // Phase 1B: route through handleMaxInbound → dispatchInboundReplyWithBase.
      ctx.log?.info?.(
        `[max-messenger:${ctx.accountId}] inbound message_created (Phase 1A scaffolding, deferred to 1B)`,
      );
      return "deferred";
    case "bot_started":
    case "message_callback":
    case "message_edited":
    case "message_removed":
    case "bot_added":
    case "bot_removed":
    case "user_added":
    case "user_removed":
    case "chat_title_changed":
      ctx.log?.info?.(
        `[max-messenger:${ctx.accountId}] inbound ${event.update_type} (Phase 1A scaffolding, log-only)`,
      );
      return "ignored";
    default: {
      const exhaustive: never = event.update_type;
      throw new Error(`unreachable: ${String(exhaustive)}`);
    }
  }
}
