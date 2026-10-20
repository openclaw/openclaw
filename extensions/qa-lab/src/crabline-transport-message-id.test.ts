import { describe, expect, it } from "vitest";
import { withTransport } from "./crabline-transport.test-support.js";

const PROVIDER_CASES = [
  {
    channel: "telegram",
    conversation: { id: "-1001234567890", kind: "group" },
    senderId: "100001",
    nativeMessageId: /^\d+$/u,
  },
  {
    channel: "matrix",
    conversation: { id: "main", kind: "group" },
    senderId: "driver",
    nativeMessageId: /^\$[A-Za-z0-9_-]{43}$/u,
  },
] as const;

describe("Crabline provider-native inbound message identity", () => {
  it.each(PROVIDER_CASES)(
    "keeps $channel message IDs consistent across the returned message and bus state",
    async ({ channel, conversation, senderId, nativeMessageId }) => {
      await withTransport(channel, async (transport, _outputDir, busState) => {
        const inbound = await transport.sendInbound({
          conversation,
          senderId,
          senderName: "Alice",
          text: `${channel} provider-native identity`,
        });
        const snapshot = transport.state.getSnapshot();

        expect(inbound.id).toMatch(nativeMessageId);
        expect(snapshot.messages).toContainEqual(
          expect.objectContaining({ direction: "inbound", id: inbound.id }),
        );
        for (const events of [snapshot.events, busState.poll().events]) {
          expect(events).toContainEqual(
            expect.objectContaining({
              kind: "inbound-message",
              message: expect.objectContaining({ id: inbound.id }),
            }),
          );
        }
        expect(transport.state.readMessage({ messageId: inbound.id })).toMatchObject({
          direction: "inbound",
          id: inbound.id,
        });
      });
    },
  );

  it("preserves Telegram message IDs repeated across independent chats", async () => {
    await withTransport("telegram", async (firstTransport, _outputDir, busState) => {
      await withTransport(
        "telegram",
        async (secondTransport) => {
          const first = await firstTransport.sendInbound({
            conversation: { id: "-1001234567890", kind: "group" },
            senderId: "100001",
            text: "first Telegram chat",
          });
          const second = await secondTransport.sendInbound({
            conversation: { id: "-1001234567891", kind: "group" },
            senderId: "100001",
            text: "second Telegram chat",
          });
          const snapshot = busState.getSnapshot();

          expect(first.id).toBe(second.id);
          expect(snapshot.messages.map((message) => message.conversation.id)).toEqual([
            first.conversation.id,
            second.conversation.id,
          ]);
          expect(snapshot.events).toEqual(
            [first, second].map((message) =>
              expect.objectContaining({
                message: expect.objectContaining({
                  id: message.id,
                  conversation: expect.objectContaining({ id: message.conversation.id }),
                }),
              }),
            ),
          );
          expect(() => busState.readMessage({ messageId: first.id })).toThrow(
            `qa-bus message id is ambiguous for selected account: ${first.id}`,
          );
        },
        undefined,
        busState,
      );
    });
  });
});
