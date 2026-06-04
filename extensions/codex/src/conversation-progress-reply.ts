import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SendCodexConversationProgressReply } from "./conversation-binding.js";

type CodexProgressReplyContext = {
  to: string;
  accountId?: string;
  threadId?: string | number;
};

type CodexProgressReplyDeps = {
  loadAdapter: (channel: string) => Promise<ChannelOutboundAdapter | null | undefined>;
  resolveConfig: () => OpenClawConfig;
  logWarn: (message: string, details: Record<string, unknown>) => void;
};

export function buildCodexConversationProgressReply(
  channel: string,
  deps: CodexProgressReplyDeps,
): SendCodexConversationProgressReply {
  return async ({ event, payload }) => {
    const to = resolveProgressReplyTarget(event);
    if (!to) {
      return;
    }
    const adapter = await deps.loadAdapter(channel);
    if (!adapter) {
      return;
    }
    const cfg = deps.resolveConfig();
    const ctx: CodexProgressReplyContext = {
      to,
      ...(event.accountId ? { accountId: event.accountId } : {}),
      ...(event.threadId != null ? { threadId: event.threadId } : {}),
    };
    if (adapter.sendPayload) {
      try {
        const results = await adapter.sendPayload({
          cfg,
          ...ctx,
          text: payload.text ?? "",
          payload,
        });
        if (results && adapter.afterDeliverPayload) {
          try {
            await adapter.afterDeliverPayload({
              cfg,
              target: {
                channel,
                ...ctx,
              },
              payload,
              results: [results],
            });
          } catch (err) {
            deps.logWarn("Codex progress reply after-delivery hook failed.", {
              channel,
              to,
              error: formatErrorMessage(err),
            });
          }
        }
        return;
      } catch (err) {
        deps.logWarn("Codex progress reply sendPayload failed.", {
          channel,
          to,
          error: formatErrorMessage(err),
        });
        return;
      }
    }
    if (payload.text && adapter.sendText) {
      await adapter.sendText({
        cfg,
        ...ctx,
        text: payload.text,
      });
    }
  };
}

function resolveProgressReplyTarget(event: {
  conversationId?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  if (event.conversationId?.trim()) {
    return event.conversationId.trim();
  }
  const to = event.metadata?.to;
  return typeof to === "string" && to.trim() ? to.trim() : undefined;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
