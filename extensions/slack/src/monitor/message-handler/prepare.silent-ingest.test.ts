import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { createInboundSlackTestContext } from "./prepare.test-helpers.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

import { prepareSlackMessage } from "./prepare.js";

describe("slack mention-skip silent ingest", () => {
  const account: ResolvedSlackAccount = {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config: {},
  };

  function createMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "hello without mention",
      ts: "1713260000.1000",
      ...overrides,
    } as SlackMessageEvent;
  }

  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const ctx = createInboundSlackTestContext({
      cfg: {
        channels: {
          slack: {
            enabled: true,
            groups: {
              "*": {
                requireMention: true,
                ingest: true,
              },
            },
          },
        },
      } as OpenClawConfig,
      defaultRequireMention: true,
    });
    ctx.resolveUserName = async () => ({ name: "Alice" }) as never;

    const result = await prepareSlackMessage({
      ctx,
      account,
      message: createMessage(),
      opts: { source: "message" },
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("slack"),
      expect.objectContaining({
        channelId: "slack",
        content: "hello without mention",
        messageId: "1713260000.1000",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit when channel ingest is false and wildcard ingest is true", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const ctx = createInboundSlackTestContext({
      cfg: {
        channels: {
          slack: {
            enabled: true,
            groups: {
              C123: {
                requireMention: true,
                ingest: false,
              },
              "*": {
                requireMention: true,
                ingest: true,
              },
            },
          },
        },
      } as OpenClawConfig,
      defaultRequireMention: true,
    });
    ctx.resolveUserName = async () => ({ name: "Alice" }) as never;

    const result = await prepareSlackMessage({
      ctx,
      account,
      message: createMessage(),
      opts: { source: "message" },
    });

    expect(result).toBeNull();
    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });
});
