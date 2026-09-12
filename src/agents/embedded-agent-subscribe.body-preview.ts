import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  hasMessageToolOnlySourceDelivery,
  shouldSuppressDeterministicApprovalOutput,
} from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

type PreviewOwner = { id: string; revision: number; retired: Set<string> };
const owners = new WeakMap<EmbeddedAgentSubscribeContext, PreviewOwner>();

/** Replaceable presentation only: never writes transcript, final text, or block reply state. */
export function handleBodyPreview(
  ctx: EmbeddedAgentSubscribeContext,
  event: Record<string, unknown>,
): void {
  if (
    ctx.params.bodyPreview !== true ||
    ctx.state.unsubscribed ||
    ctx.params.isTerminalAborted?.() ||
    ctx.params.enforceFinalTag ||
    ctx.params.suppressLiveStreamOutput ||
    ctx.params.silentExpected ||
    ctx.state.deferBlockReplyDelivery ||
    !ctx.state.shouldEmitPartialReplies ||
    shouldSuppressDeterministicApprovalOutput(ctx.state) ||
    hasMessageToolOnlySourceDelivery(ctx) ||
    ctx.params.sourceReplyDeliveryMode === "message_tool_only"
  ) {
    return;
  }
  const { previewId, revision, text, reset } = event;
  if (
    typeof previewId !== "string" ||
    !previewId ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof text !== "string" ||
    typeof reset !== "boolean"
  ) {
    return;
  }
  const previous = owners.get(ctx);
  if (
    previous?.retired.has(previewId) ||
    (previous?.id === previewId && revision <= previous.revision)
  ) {
    return;
  }
  const retired = previous?.retired ?? new Set<string>();
  if (previous && previous.id !== previewId) {
    retired.add(previous.id);
  }
  owners.set(ctx, { id: previewId, revision, retired });
  const parsed = parseReplyDirectives(splitTrailingDirective(text).text);
  runBestEffortCallback({
    label: "assistant body preview",
    log: ctx.log,
    callback: () =>
      ctx.params.onPartialReply?.({
        text: reset || parsed.isSilent ? "" : parsed.text,
        replace: true,
        previewId,
        revision,
        reset: reset || parsed.isSilent,
      }),
  });
}
