import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import {
  baseTelegramMessageContextConfig,
  buildTelegramMessageContextForTest,
} from "./bot-message-context.test-harness.js";

const baseConfig = baseTelegramMessageContextConfig as unknown as Record<string, unknown>;

describe("buildTelegramMessageContext dm isolation", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("isolates DMs from the main session when dmScope is unset", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:7463849194");
  });

  it("respects explicit dmScope main", async () => {
    const cfg = {
      ...baseConfig,
      session: { dmScope: "main" },
    };
    setRuntimeConfigSnapshot(cfg as never);

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });

  it("does not rewrite explicit direct-peer bindings that intentionally target main", async () => {
    const cfg = {
      ...baseConfig,
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "telegram",
            peer: { kind: "direct", id: "7463849194" },
          },
        },
      ],
    };
    setRuntimeConfigSnapshot(cfg as never);

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.matchedBy).toBe("binding.peer");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });

  it("does not rewrite explicit account bindings that intentionally target main", async () => {
    const cfg = {
      ...baseConfig,
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "telegram",
            accountId: "default",
          },
        },
      ],
    };
    setRuntimeConfigSnapshot(cfg as never);

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.matchedBy).toBe("binding.account");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });

  it("preserves explicit per-peer isolation", async () => {
    const cfg = {
      ...baseConfig,
      session: { dmScope: "per-peer" },
    };
    setRuntimeConfigSnapshot(cfg as never);

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:direct:7463849194");
  });

  it("does not affect group routing", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -100123456, type: "supergroup", title: "Test Group" },
        from: { id: 42, first_name: "Alice" },
        text: "hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-100123456");
  });
});
