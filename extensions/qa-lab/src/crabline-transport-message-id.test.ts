import { describe, expect, it } from "vitest";
import { withTransport } from "./crabline-transport.test-support.js";

describe("Crabline provider-native inbound message identity", () => {
  it.each([
    ["telegram", "-1001234567890", "100001", /^\d+$/u],
    ["matrix", "main", "driver", /^\$[A-Za-z0-9_-]{43}$/u],
  ] as const)(
    "keeps %s message IDs consistent across the returned message and bus state",
    async (channel, id, senderId, nativeMessageId) => {
      await withTransport(channel, async (transport) => {
        const inbound = await transport.sendInbound({
          conversation: { id, kind: "group" },
          senderId,
          text: "provider-native identity",
        });
        expect(inbound.id).toMatch(nativeMessageId);
        expect(transport.state.getSnapshot()).toMatchObject({
          messages: [{ direction: "inbound", id: inbound.id }],
          events: [{ kind: "inbound-message", message: { id: inbound.id } }],
        });
      });
    },
  );

  it("preserves Telegram message IDs repeated across independent chats", async () => {
    const input = (id: string) => ({
      conversation: { id, kind: "group" as const },
      senderId: "100001",
      text: "Telegram chat",
    });
    await withTransport("telegram", async (firstTransport, _outputDir, busState) => {
      await withTransport(
        "telegram",
        async (secondTransport) => {
          const first = await firstTransport.sendInbound(input("-1001234567890"));
          const second = await secondTransport.sendInbound(input("-1001234567891"));
          expect(first.id).toBe(second.id);
          const identities = [first, second].map(({ id, conversation }) => ({
            id,
            conversation: { id: conversation.id },
          }));
          expect(busState.getSnapshot()).toMatchObject({
            messages: identities,
            events: identities.map((message) => ({ message })),
          });
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
