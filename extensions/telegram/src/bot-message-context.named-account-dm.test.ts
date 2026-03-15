import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const recordInboundSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

describe("buildTelegramMessageContext named-account DM fallback", () => {
  const baseCfg = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  };

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    recordInboundSessionMock.mockClear();
  });

  it("drops DM for a named account with no explicit binding", async () => {
    setRuntimeConfigSnapshot(baseCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: baseCfg,
      accountId: "atlas",
      message: {
        message_id: 1,
        chat: { id: 814912386, type: "private" },
        date: 1700000000,
        text: "hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    expect(ctx).toBeNull();
  });

  it("still drops named-account group messages without an explicit binding", async () => {
    setRuntimeConfigSnapshot(baseCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: baseCfg,
      accountId: "atlas",
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      message: {
        message_id: 1,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000000,
        text: "@bot hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    expect(ctx).toBeNull();
  });

  it("does not change the default-account DM session key", async () => {
    setRuntimeConfigSnapshot(baseCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: baseCfg,
      message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        date: 1700000000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});
