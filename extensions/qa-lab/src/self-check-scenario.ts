import type { QaBusMessage } from "openclaw/plugin-sdk/qa-channel-protocol";
import { extractToolPayload as extractQaToolPayload } from "openclaw/plugin-sdk/tool-payload";
import type { QaTransportState } from "./qa-transport.js";
import type { QaScenarioDefinition } from "./scenario.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

export function createQaSelfCheckScenario(options?: {
  waitTimeoutMs?: number;
}): QaScenarioDefinition {
  const waitTimeoutMs = options?.waitTimeoutMs ?? 5_000;
  let lifecycle: { target: string; threadId: string; message: QaBusMessage } | undefined;
  const waitForReply = (state: QaTransportState, inbound: QaBusMessage) =>
    waitForOutboundMessage(
      state,
      (message) =>
        message.conversation.id === inbound.conversation.id &&
        message.conversation.kind === inbound.conversation.kind &&
        message.threadId === inbound.threadId &&
        message.text.includes(`qa-echo: ${inbound.text}`),
      waitTimeoutMs,
      { accountId: inbound.accountId },
    );
  return {
    name: "Synthetic Slack-class roundtrip",
    steps: [
      {
        name: "DM echo roundtrip",
        async run({ state }) {
          const inbound = await state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "hello from qa",
          });
          await waitForReply(state, inbound);
        },
      },
      {
        name: "Thread create and threaded echo",
        async run({ state, performAction }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          const threadResult = await performAction("thread-create", {
            channelId: "qa-room",
            title: "QA thread",
          });
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
            message: await waitForReply(state, inbound),
          };
          return threadId;
        },
      },
      {
        name: "Reaction, edit, delete lifecycle",
        async run({ state, performAction }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          if (!lifecycle) {
            throw new Error("threaded outbound message and target not found");
          }
          const { target, threadId, message: outboundMessage } = lifecycle;
          const actions = [
            {
              action: "react",
              args: { emoji: "white_check_mark" },
              missing: "reacted message not found",
              unrecorded: "reaction not recorded",
              recorded: (message: QaBusMessage) => message.reactions.length !== 0,
            },
            {
              action: "edit",
              args: { text: "qa-echo: inside thread (edited)" },
              missing: "edited message not found",
              unrecorded: "edit not recorded",
              recorded: (message: QaBusMessage) => message.text.includes("(edited)"),
            },
            {
              action: "delete",
              args: {},
              missing: "deleted message not found",
              unrecorded: "delete not recorded",
              recorded: (message: QaBusMessage) => message.deleted,
            },
          ] as const;
          for (const { action, args, missing, unrecorded, recorded } of actions) {
            await performAction(action, {
              to: target,
              threadId,
              messageId: outboundMessage.id,
              ...args,
            });
            const message = await state.readMessage({ messageId: outboundMessage.id });
            if (!message) {
              throw new Error(missing);
            }
            if (!recorded(message)) {
              throw new Error(unrecorded);
            }
          }
        },
      },
    ],
  };
}
