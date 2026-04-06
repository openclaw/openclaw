import { extractQaToolPayload } from "./extract-tool-payload.js";
import { qaChannelPlugin, type OpenClawConfig } from "./runtime-api.js";
import type { QaScenarioDefinition } from "./scenario.js";

export function createQaSelfCheckScenario(cfg: OpenClawConfig): QaScenarioDefinition {
  return {
    name: "Synthetic Slack-class roundtrip",
    steps: [
      {
        name: "DM echo roundtrip",
        async run({ state }) {
          state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "hello from qa",
          });
          await state.waitFor({
            kind: "message-text",
            textIncludes: "qa-echo: hello from qa",
            direction: "outbound",
            timeoutMs: 5_000,
          });
        },
      },
      {
        name: "Thread create and threaded echo",
        async run({ state }) {
          const threadResult = await qaChannelPlugin.actions?.handleAction?.({
            channel: "qa-channel",
            action: "thread-create",
            cfg,
            accountId: "default",
            params: {
              channelId: "qa-room",
              title: "QA thread",
            },
          });
          const threadPayload = extractQaToolPayload(threadResult) as
            | { thread?: { id?: string } }
            | undefined;
          const threadId = threadPayload?.thread?.id;
          if (!threadId) {
            throw new Error("thread-create did not return thread id");
          }

          state.addInboundMessage({
            conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
            senderId: "alice",
            senderName: "Alice",
            text: "inside thread",
            threadId,
            threadTitle: "QA thread",
          });
          await state.waitFor({
            kind: "message-text",
            textIncludes: "qa-echo: inside thread",
            direction: "outbound",
            timeoutMs: 5_000,
          });
          return threadId;
        },
      },
      {
        name: "Reaction, edit, delete lifecycle",
        async run({ state }) {
          const outbound = state
            .searchMessages({ query: "qa-echo: inside thread", conversationId: "qa-room" })
            .at(-1);
          if (!outbound) {
            throw new Error("threaded outbound message not found");
          }

          await qaChannelPlugin.actions?.handleAction?.({
            channel: "qa-channel",
            action: "react",
            cfg,
            accountId: "default",
            params: {
              messageId: outbound.id,
              emoji: "white_check_mark",
            },
          });
          const reacted = state.readMessage({ messageId: outbound.id });
          if (reacted.reactions.length === 0) {
            throw new Error("reaction not recorded");
          }

          await qaChannelPlugin.actions?.handleAction?.({
            channel: "qa-channel",
            action: "edit",
            cfg,
            accountId: "default",
            params: {
              messageId: outbound.id,
              text: "qa-echo: inside thread (edited)",
            },
          });
          const edited = state.readMessage({ messageId: outbound.id });
          if (!edited.text.includes("(edited)")) {
            throw new Error("edit not recorded");
          }

          await qaChannelPlugin.actions?.handleAction?.({
            channel: "qa-channel",
            action: "delete",
            cfg,
            accountId: "default",
            params: {
              messageId: outbound.id,
            },
          });
          const deleted = state.readMessage({ messageId: outbound.id });
          if (!deleted.deleted) {
            throw new Error("delete not recorded");
          }
        },
      },
    ],
  };
}
