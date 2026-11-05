import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { withTransport } from "./crabline-transport.test-support.js";
import { createQaTransportAdapter } from "./qa-transport-registry.js";

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

  it("reports only the last eight owned native Matrix inbound IDs on timeout", async () => {
    await withTempDir("qa-matrix-timeout-", async (outputDir) => {
      const state = createQaBusState();
      const created = await createQaTransportAdapter({
        channelId: "matrix",
        driver: "crabline",
        outputDir,
        state,
      });
      const transport = created.adapter;
      try {
        const ids: string[] = [];
        const input = {
          conversation: { id: "private-room", kind: "group" as const },
          senderId: "@private-sender:matrix.test",
          text: "private message content",
        };
        for (let index = 0; index < 10; index += 1) {
          ids.push((await transport.sendInbound(input)).id);
        }
        state.addInboundMessage({ ...input, accountId: "other" }, "$" + "Z".repeat(43));
        state.addInboundMessage(
          { ...input, accountId: transport.accountId },
          "private-nonnative-id",
        );
        state.addOutboundMessage({
          accountId: transport.accountId,
          to: "group:private-room",
          text: "private outbound content",
        });
        const error = await transport
          .waitForOutbound({ textIncludes: "missing marker", timeoutMs: 0 })
          .catch((caught: unknown) => caught);
        const message = String(error);
        expect(message).toContain(`matrix inbound event IDs=${JSON.stringify(ids.slice(-8))}`);
        expect(message).not.toContain(ids[0]);
        expect(message).not.toContain(ids[1]);
        expect(message).not.toMatch(
          /private-room|private-sender|private message content|private outbound content|private-nonnative-id|Z{43}/u,
        );
      } finally {
        await created.cleanupWithoutGateway();
      }
    });
  });

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
