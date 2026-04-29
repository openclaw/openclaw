import { describe, expect, it, vi } from "vitest";
import type { BackendFn, EffectiveChannelConfig } from "./config.js";
import { createGuardrailsHandler } from "./handler.js";

type HandlerConfig = Pick<EffectiveChannelConfig, "fallbackOnError" | "blockMessage">;

function makeConfig(overrides: Partial<HandlerConfig> = {}): HandlerConfig {
  return {
    fallbackOnError: "pass",
    blockMessage: "Blocked by policy.",
    ...overrides,
  };
}

function makeEvent(content: string) {
  return { content, channel: "test", sessionKey: "sess1", senderId: "user1" };
}

function makeCtx() {
  return { channelId: "test", sessionKey: "sess1", senderId: "user1" };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("handler", () => {
  it("returns handled=false for pass", async () => {
    const backend: BackendFn = async () => ({ action: "pass" });
    const handler = createGuardrailsHandler(backend, makeConfig(), logger);
    const result = await handler(makeEvent("hello"), makeCtx());
    expect(result).toEqual({ handled: false });
  });

  it("returns handled=true with text for static block", async () => {
    const backend: BackendFn = async () => ({ action: "block", blockMessage: "bad content" });
    const handler = createGuardrailsHandler(backend, makeConfig(), logger);
    const result = await handler(makeEvent("bad"), makeCtx());
    expect(result).toEqual({ handled: true, text: "bad content" });
  });

  it("uses config.blockMessage when no blockMessage in result", async () => {
    const backend: BackendFn = async () => ({ action: "block" });
    const handler = createGuardrailsHandler(
      backend,
      makeConfig({ blockMessage: "Config block msg" }),
      logger,
    );
    const result = await handler(makeEvent("bad"), makeCtx());
    expect(result).toEqual({ handled: true, text: "Config block msg" });
  });

  // ── error handling ────────────────────────────────────────────────────

  it.each([
    ["pass", { fallbackOnError: "pass" as const }, { handled: false }],
    [
      "block",
      { fallbackOnError: "block" as const, blockMessage: "Error block" },
      { handled: true, text: "Error block" },
    ],
  ])("falls back to %s on backend error", async (_label, configOverride, expected) => {
    const backend: BackendFn = async () => {
      throw new Error("backend down");
    };
    const handler = createGuardrailsHandler(backend, makeConfig(configOverride), logger);
    expect(await handler(makeEvent("text"), makeCtx())).toEqual(expected);
  });

  it("falls back on timeout error from backend", async () => {
    const backend: BackendFn = async () => {
      throw new Error("guardrails: timeout");
    };
    const handler = createGuardrailsHandler(
      backend,
      makeConfig({ fallbackOnError: "block", blockMessage: "Timeout block" }),
      logger,
    );
    const result = await handler(makeEvent("text"), makeCtx());
    expect(result).toEqual({ handled: true, text: "Timeout block" });
  });

  it("uses event.body when content is absent", async () => {
    let capturedText = "";
    const backend: BackendFn = async (text) => {
      capturedText = text;
      return { action: "pass" };
    };
    const handler = createGuardrailsHandler(backend, makeConfig(), logger);
    const result = await handler({ body: "body text", channel: "test" }, makeCtx());
    expect(result).toEqual({ handled: false });
    expect(capturedText).toBe("body text");
  });

  it("maps event fields to CheckContext correctly", async () => {
    let capturedContext: any;
    const backend: BackendFn = async (_text, context) => {
      capturedContext = context;
      return { action: "pass" };
    };
    const handler = createGuardrailsHandler(backend, makeConfig(), logger);
    await handler(
      { content: "hi", channel: "telegram", sessionKey: "s1", senderId: "u1" },
      { channelId: "discord", sessionKey: "s2", senderId: "u2" },
    );
    // ctx fields take priority over event fields
    expect(capturedContext).toEqual({
      sessionKey: "s2",
      channelId: "discord",
      userId: "u2",
    });
  });

  it("returns handled=false for unknown action", async () => {
    const backend: BackendFn = async () => ({ action: "unknown" as any });
    const handler = createGuardrailsHandler(backend, makeConfig(), logger);
    const result = await handler(makeEvent("text"), makeCtx());
    expect(result).toEqual({ handled: false });
  });
});
