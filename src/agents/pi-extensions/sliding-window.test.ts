import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import slidingWindowExtension, { setSlidingWindowRuntime } from "./sliding-window.js";

function makeMessages(roles: Array<"user" | "assistant">): AgentMessage[] {
  return roles.map((role, i) => ({
    role,
    content: [{ type: "text" as const, text: `message-${i}` }],
  }));
}

function runExtension(
  messages: AgentMessage[],
  maxExchanges: number,
): AgentMessage[] | undefined {
  const sessionManager = {};
  setSlidingWindowRuntime(sessionManager, { maxExchanges });

  let handler: ((event: ContextEvent, ctx: ExtensionContext) => { messages: AgentMessage[] } | undefined) | undefined;

  const api: ExtensionAPI = {
    on(eventName: string, cb: any) {
      if (eventName === "context") {
        handler = cb;
      }
    },
  } as unknown as ExtensionAPI;

  slidingWindowExtension(api);

  if (!handler) {
    throw new Error("No context handler registered");
  }

  const event: ContextEvent = { messages } as ContextEvent;
  const ctx = { sessionManager } as unknown as ExtensionContext;
  const result = handler(event, ctx);
  return result?.messages;
}

describe("slidingWindowExtension", () => {
  it("should not trim when under the limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    const result = runExtension(messages, 5);
    expect(result).toBeUndefined();
  });

  it("should trim to exactly maxExchanges user messages", () => {
    // 6 user exchanges, limit 3
    const messages = makeMessages([
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
    ]);
    const result = runExtension(messages, 3);
    expect(result).toBeDefined();
    // Should start from the 4th user message (index 6)
    expect(result).toEqual(messages.slice(6));
    // Verify we kept exactly 3 user messages
    const userCount = result!.filter((m) => m.role === "user").length;
    expect(userCount).toBe(3);
  });

  it("should return undefined for empty messages", () => {
    const result = runExtension([], 5);
    expect(result).toBeUndefined();
  });

  it("should not trim when exactly at the limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    const result = runExtension(messages, 2);
    expect(result).toBeUndefined();
  });

  it("should disable when maxExchanges is 0", () => {
    const messages = makeMessages([
      "user", "assistant",
      "user", "assistant",
      "user", "assistant",
    ]);
    const result = runExtension(messages, 0);
    expect(result).toBeUndefined();
  });

  it("should handle consecutive user messages", () => {
    // Sometimes multiple user messages arrive without assistant responses
    const messages = makeMessages([
      "user", "assistant",
      "user", "user", "assistant",
      "user", "assistant",
    ]);
    const result = runExtension(messages, 2);
    expect(result).toBeDefined();
    // 4 user messages total, keep last 2: starts from index 3 (3rd user)
    const userCount = result!.filter((m) => m.role === "user").length;
    expect(userCount).toBe(2);
  });
});
