import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { injectHistoryImagesIntoMessages, installTranscriptPromptGuard } from "./attempt.js";

describe("injectHistoryImagesIntoMessages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("injects history images and converts string content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "See /tmp/photo.png",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(true);
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const content = messages[0]?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("avoids duplicating existing image content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(false);
    const first = messages[0];
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
  });

  it("ignores non-user messages and out-of-range indices", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "noop",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[1, [image]]]));

    expect(didMutate).toBe(false);
    expect(messages[0]?.content).toBe("noop");
  });
});

describe("installTranscriptPromptGuard", () => {
  function makeMockSessionManager() {
    const appended: AgentMessage[] = [];
    return {
      appendMessage: vi.fn((msg: AgentMessage) => {
        appended.push(msg);
      }),
      appended,
    };
  }

  it("replaces the first user message content with the original prompt", () => {
    const sm = makeMockSessionManager();
    const teardown = installTranscriptPromptGuard(sm, "Hello");

    // Simulate what activeSession.prompt() does internally: appends a user message
    sm.appendMessage({ role: "user", content: "MEMORY CONTEXT\n\nHello" } as AgentMessage);

    expect(sm.appended).toHaveLength(1);
    expect(sm.appended[0]?.content).toBe("Hello");
    expect((sm.appended[0] as { role: string }).role).toBe("user");

    teardown();
  });

  it("only intercepts the first user message (one-shot)", () => {
    const sm = makeMockSessionManager();
    const teardown = installTranscriptPromptGuard(sm, "original");

    sm.appendMessage({ role: "user", content: "modified1" } as AgentMessage);
    sm.appendMessage({ role: "user", content: "modified2" } as AgentMessage);

    expect(sm.appended).toHaveLength(2);
    // First user message: replaced with original
    expect(sm.appended[0]?.content).toBe("original");
    // Second user message: passed through unmodified
    expect(sm.appended[1]?.content).toBe("modified2");

    teardown();
  });

  it("passes non-user messages through unmodified", () => {
    const sm = makeMockSessionManager();
    const teardown = installTranscriptPromptGuard(sm, "original");

    // Assistant message should pass through untouched
    sm.appendMessage({ role: "assistant", content: "response" } as AgentMessage);

    expect(sm.appended).toHaveLength(1);
    expect(sm.appended[0]?.content).toBe("response");

    // The next user message should still be intercepted (guard hasn't fired yet)
    sm.appendMessage({ role: "user", content: "modified" } as AgentMessage);
    expect(sm.appended[1]?.content).toBe("original");

    teardown();
  });

  it("restores original appendMessage on teardown", () => {
    const sm = makeMockSessionManager();
    const originalFn = sm.appendMessage;
    const teardown = installTranscriptPromptGuard(sm, "original");

    // appendMessage should be replaced
    expect(sm.appendMessage).not.toBe(originalFn);

    teardown();

    // After teardown, the original function is restored
    // (it's the bound version, so we verify by calling it)
    sm.appendMessage({ role: "user", content: "after teardown" } as AgentMessage);
    expect(sm.appended).toHaveLength(1);
    expect(sm.appended[0]?.content).toBe("after teardown");
  });

  it("preserves other message properties when replacing content", () => {
    const sm = makeMockSessionManager();
    const teardown = installTranscriptPromptGuard(sm, "clean prompt");

    const msg = {
      role: "user",
      content: "dirty prompt with context",
      metadata: { source: "telegram" },
    } as AgentMessage;
    sm.appendMessage(msg);

    expect(sm.appended[0]?.content).toBe("clean prompt");
    expect((sm.appended[0] as Record<string, unknown>).metadata).toEqual({ source: "telegram" });

    teardown();
  });
});
