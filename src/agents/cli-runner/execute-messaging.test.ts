// Regression coverage for openclaw-kg9: CLI/loopback sends never carry the
// gateway's trusted current-source route tag, so the runner must verify the
// route itself to keep an explicit-route reply to the current source counted
// as a source reply (and not trip stranded-reply recovery).
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { cliSendResolvesToCurrentSource } from "./execute-messaging.js";
import type { PreparedCliRunContext } from "./types.js";

const CURRENT_CHANNEL_ID = "C0B2EDDPW95";

function makeContext(overrides: Record<string, unknown> = {}): PreparedCliRunContext {
  return {
    params: {
      messageProvider: "slack",
      currentChannelId: CURRENT_CHANNEL_ID,
      sourceReplyDeliveryMode: "message_tool_only",
      ...overrides,
    },
  } as unknown as PreparedCliRunContext;
}

describe("cliSendResolvesToCurrentSource", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim() || undefined },
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
                typeof args.to === "string" ? { to: args.to } : null,
            },
          },
          source: "test",
        },
      ]),
    );
  });

  it("treats an explicit route to the current source as a current-source reply", () => {
    expect(
      cliSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        channel: "slack",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(true);
  });

  it("accepts the loopback-prefixed tool name", () => {
    expect(
      cliSendResolvesToCurrentSource(makeContext(), "mcp__openclaw__message", {
        action: "send",
        channel: "slack",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(true);
  });

  it("rejects an explicit route to a different conversation", () => {
    expect(
      cliSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        channel: "slack",
        to: "C-SOMEWHERE-ELSE",
        message: "reply",
      }),
    ).toBe(false);
  });

  it("treats an implicit routeless send as the current source", () => {
    expect(
      cliSendResolvesToCurrentSource(makeContext(), "message", {
        action: "send",
        message: "reply",
      }),
    ).toBe(true);
  });

  it("returns false when there is no current source channel", () => {
    expect(
      cliSendResolvesToCurrentSource(makeContext({ currentChannelId: undefined }), "message", {
        action: "send",
        channel: "slack",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(false);
  });

  it("ignores non-message tools", () => {
    expect(
      cliSendResolvesToCurrentSource(makeContext(), "sessions_send", {
        action: "send",
        to: CURRENT_CHANNEL_ID,
        message: "reply",
      }),
    ).toBe(false);
  });
});
