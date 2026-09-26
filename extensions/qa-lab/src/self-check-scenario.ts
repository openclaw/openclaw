import { extractQaToolPayload } from "./extract-tool-payload.js";
import type { QaTransportState } from "./qa-transport.js";
import type { QaBusMessage } from "./runtime-api.js";
import type { QaScenarioDefinition } from "./scenario.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

export function createQaSelfCheckScenario(options?: {
  waitTimeoutMs?: number;
}): QaScenarioDefinition {
  const waitTimeoutMs = options?.waitTimeoutMs ?? 5_000;
  let lifecycle: { target: string; threadId: string; message: QaBusMessage } | undefined;
  const waitForReply = (state: QaTransportState, inbound: QaBusMessage, signal?: AbortSignal) =>
    waitForOutboundMessage(
      state,
      (message) =>
        message.conversation.id === inbound.conversation.id &&
        message.conversation.kind === inbound.conversation.kind &&
        message.threadId === inbound.threadId &&
        message.text.includes(`qa-echo: ${inbound.text}`),
      waitTimeoutMs,
      { accountId: inbound.accountId, signal },
    );
  return {
    name: "Synthetic Slack-class roundtrip",
    steps: [
      {
        name: "DM echo roundtrip",
        async run({ state, signal }) {
          const inbound = await state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "hello from qa",
          });
          await waitForReply(state, inbound, signal);
        },
      },
      {
        name: "Thread create and threaded echo",
        async run({ state, performAction, signal }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          const threadResult = await performAction("thread-create", {
            channelId: "qa-room",
            title: "QA thread",
          });
          signal?.throwIfAborted();
          const threadPayload = extractQaToolPayload(
            threadResult as Parameters<typeof extractQaToolPayload>[0],
          ) as { target?: string; threadId?: string; thread?: { id?: string } } | undefined;
          const threadId = threadPayload?.threadId;
          if (!threadId || threadId !== threadPayload?.thread?.id || !threadPayload.target) {
            throw new Error("thread-create did not return thread id and target");
          }
          const inbound = await state.addInboundMessage({
            conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
            senderId: "alice",
            senderName: "Alice",
            text: "inside thread",
            threadId,
            threadTitle: "QA thread",
          });
          lifecycle = {
            target: threadPayload.target,
            threadId,
            message: await waitForReply(state, inbound, signal),
          };
          return threadId;
        },
      },
      {
        name: "Reaction, edit, delete lifecycle",
        async run({ state, performAction, signal }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          if (!lifecycle) {
            throw new Error("threaded outbound message and target not found");
          }
          const { target, threadId, message: outboundMessage } = lifecycle;

          await performAction("react", {
            to: target,
            threadId,
            messageId: outboundMessage.id,
            emoji: "white_check_mark",
          });
          signal?.throwIfAborted();
          const reacted = await state.readMessage({ messageId: outboundMessage.id });
          signal?.throwIfAborted();
          if (!reacted) {
            throw new Error("reacted message not found");
          }
          if (reacted.reactions.length === 0) {
            throw new Error("reaction not recorded");
          }

          await performAction("edit", {
            to: target,
            threadId,
            messageId: outboundMessage.id,
            text: "qa-echo: inside thread (edited)",
          });
          signal?.throwIfAborted();
          const edited = await state.readMessage({ messageId: outboundMessage.id });
          signal?.throwIfAborted();
          if (!edited) {
            throw new Error("edited message not found");
          }
          if (!edited.text.includes("(edited)")) {
            throw new Error("edit not recorded");
          }

          await performAction("delete", {
            to: target,
            threadId,
            messageId: outboundMessage.id,
          });
          signal?.throwIfAborted();
          const deleted = await state.readMessage({ messageId: outboundMessage.id });
          signal?.throwIfAborted();
          if (!deleted) {
            throw new Error("deleted message not found");
          }
          if (!deleted.deleted) {
            throw new Error("delete not recorded");
          }
        },
      },
    ],
  };
}
