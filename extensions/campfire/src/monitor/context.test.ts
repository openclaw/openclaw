import { describe, expect, it } from "vitest";
import type { CampfireWebhookPayload } from "../types.js";
import { buildCampfireInboundContext } from "./context.js";

function createPayload(overrides?: Partial<CampfireWebhookPayload>): CampfireWebhookPayload {
  return {
    user: { id: 42, name: "Alice" },
    room: {
      id: 7,
      name: "General",
      path: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
    },
    message: {
      id: 99,
      body: {
        html: "<p>Hey @Bot help me</p>",
        plain: "Hey help me",
      },
      path: "https://campfire.example.com/rooms/7/@99",
    },
    ...overrides,
  };
}

describe("buildCampfireInboundContext", () => {
  it("blocks users outside allowFrom", () => {
    const context = buildCampfireInboundContext({
      payload: createPayload(),
      allowFrom: ["77", "Bob"],
      baseUrl: "https://campfire.example.com",
    });

    expect(context.isAllowed).toBe(false);
  });

  it("allows all users when allowFrom is empty", () => {
    const context = buildCampfireInboundContext({
      payload: createPayload(),
      allowFrom: [],
      baseUrl: "https://campfire.example.com",
    });

    expect(context.isAllowed).toBe(true);
    expect(context.sender).toEqual({ id: "42", name: "Alice" });
    expect(context.replyUrl).toBe("https://campfire.example.com/rooms/7/42-AbCdEf/messages");
  });

  it("uses a stable thread key for the same room", () => {
    const first = buildCampfireInboundContext({
      payload: createPayload(),
      allowFrom: [],
      baseUrl: "https://campfire.example.com",
    });
    const second = buildCampfireInboundContext({
      payload: createPayload({ message: { id: 100, body: { plain: "follow up" }, path: "x" } }),
      allowFrom: [],
      baseUrl: "https://campfire.example.com",
    });

    expect(first.threadKey).toBe("campfire:room:7");
    expect(second.threadKey).toBe("campfire:room:7");
  });

  it("blocks reply URLs outside the configured workspace path", () => {
    const context = buildCampfireInboundContext({
      payload: createPayload({
        room: {
          id: 7,
          name: "General",
          path: "https://3.basecamp.com/7654321/buckets/7/chats/88/messages/99",
        },
      }),
      allowFrom: [],
      baseUrl: "https://3.basecamp.com/1234567",
    });

    expect(context.isAllowed).toBe(false);
  });
});
