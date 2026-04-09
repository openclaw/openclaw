import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { applyReplyBoundaryGuard } from "./policy.ts";

function rewriteAssistantMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant") {
    return message;
  }

  let changed = false;
  const clone = structuredClone(message) as { role?: unknown; content?: unknown };

  if (typeof clone.content === "string") {
    const result = applyReplyBoundaryGuard(clone.content);
    if (result.outputChanged) {
      clone.content = result.outputText;
      changed = true;
    }
  } else if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const original = (block as { text: string }).text;
        const result = applyReplyBoundaryGuard(original);
        if (result.outputChanged) {
          changed = true;
          return { ...(block as Record<string, unknown>), text: result.outputText };
        }
      }
      return block;
    });
  }

  return changed ? clone : message;
}

export default definePluginEntry({
  id: "reply-boundary-guard",
  name: "Reply Boundary Guard",
  description:
    "Applies canonical reply-boundary policy to outbound replies and supplements bare auto-report-back promises.",
  register(api) {
    api.on("message_sending", async (event, ctx) => {
      if (ctx.channelId !== "telegram") {
        return;
      }
      const result = applyReplyBoundaryGuard(event.content ?? "");
      if (result.outputChanged) {
        api.logger.info?.(
          `reply-boundary-guard: rewrote outbound Telegram reply-boundary text (canonical=${result.usedCanonicalPolicy} reportBackSupplement=${result.usedReportBackSupplement})`,
        );
        return { content: result.outputText };
      }
    });

    api.on("before_message_write", (event) => {
      const rewrittenMessage = rewriteAssistantMessage(event.message);
      if (rewrittenMessage !== event.message) {
        return { message: rewrittenMessage as typeof event.message };
      }
    });
  },
});
