import { describe, expect, it, vi } from "vitest";
import { createClickClackClient, isClickClackCommittedMessageCreateError } from "./http-client.js";

describe("ClickClack committed message errors", () => {
  it("recognizes only committed message-create errors", async () => {
    type Client = ReturnType<typeof createClickClackClient>;
    const captureError = async (
      response: Response,
      invoke: (client: Client) => Promise<unknown>,
    ): Promise<unknown> => {
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "placeholder",
        fetch: vi.fn(async () => response) as unknown as typeof fetch,
      });
      return await invoke(client).catch((error: unknown) => error);
    };
    const createChannelMessage = async (client: Client): Promise<unknown> =>
      await client.createChannelMessage("chn_1", "reply");
    const messageCreates: Array<(client: Client) => Promise<unknown>> = [
      createChannelMessage,
      async (client) => await client.createThreadReply("msg_1", "reply"),
      async (client) => await client.createDirectMessage("dm_1", "reply"),
    ];

    for (const createMessage of messageCreates) {
      for (const status of [200, 201]) {
        expect(
          isClickClackCommittedMessageCreateError(
            await captureError(new Response("{", { status }), createMessage),
          ),
        ).toBe(true);
      }
    }
    for (const status of [400, 409]) {
      expect(
        isClickClackCommittedMessageCreateError(
          await captureError(
            new Response("client nonce was already used for a different message", { status }),
            createChannelMessage,
          ),
        ),
      ).toBe(true);
    }
    expect(
      isClickClackCommittedMessageCreateError(
        await captureError(new Response("{", { status: 200 }), async (client) => await client.me()),
      ),
    ).toBe(false);
    expect(
      isClickClackCommittedMessageCreateError(
        await captureError(
          new Response("message body is required", { status: 400 }),
          createChannelMessage,
        ),
      ),
    ).toBe(false);
    expect(
      isClickClackCommittedMessageCreateError(
        await captureError(new Response("{", { status: 202 }), createChannelMessage),
      ),
    ).toBe(false);
    expect(
      isClickClackCommittedMessageCreateError(
        await captureError(
          new Response("{", { status: 200 }),
          async (client) => await client.createDirectConversation("ws_1", ["usr_1"]),
        ),
      ),
    ).toBe(false);
  });
});
