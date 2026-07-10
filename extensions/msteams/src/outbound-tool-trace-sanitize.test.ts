// MSTeams outbound sanitization is proven at the send-dependency boundary so the
// shared delivery hook, target routing, and sanitized text cannot drift apart
// unnoticed.
import {
  createTestRegistry,
  deliverOutboundPayloads,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { msteamsPlugin } from "./channel.js";

type CapturedSend = { to: string; text: string };

describe("msteams outbound assistant-visible sanitization", () => {
  const capturedSends: CapturedSend[] = [];
  const mockSend = vi.fn(
    async (to: string, text: string): Promise<{ messageId: string; conversationId: string }> => {
      capturedSends.push({ to, text });
      return { messageId: `msg-${capturedSends.length}`, conversationId: `conv-${to}` };
    },
  );

  beforeEach(() => {
    capturedSends.length = 0;
    mockSend.mockClear();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    vi.restoreAllMocks();
  });

  const baseCfg = {
    channels: {
      msteams: {
        appId: "test-bot-id",
        appPassword: "test-secret",
        tenantId: "test-tenant",
      },
    },
  } as OpenClawConfig;

  it("sanitizes tool-trace banners from outbound text before the send boundary (#103692)", async () => {
    await deliverOutboundPayloads({
      cfg: baseCfg,
      channel: "msteams",
      to: "user:test-user",
      payloads: [
        {
          text: ["**Done.**", "⚠️ 🛠️ `search repos (agent)` failed", "", "All clear."].join("\n"),
        },
      ],
      skipQueue: true,
      deps: { msteams: mockSend },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = capturedSends[0];
    expect(sent.to).toBe("user:test-user");
    // Tool-trace banner must be stripped; prose-only payload must be preserved.
    expect(sent.text).toContain("**Done.**");
    expect(sent.text).not.toContain("search repos");
    expect(sent.text).not.toContain("🛠️");
    expect(sent.text).toContain("All clear.");
  });

  it("suppresses trace-only outbound payloads before the send boundary (#103692)", async () => {
    await deliverOutboundPayloads({
      cfg: baseCfg,
      channel: "msteams",
      to: "user:test-user",
      payloads: [
        {
          text: "⚠️ 🛠️ `run diagnostic (agent)` failed",
        },
      ],
      skipQueue: true,
      deps: { msteams: mockSend },
    });

    // Trace-only payloads must be suppressed (no send).
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("preserves clean prose through the send boundary (#103692)", async () => {
    await deliverOutboundPayloads({
      cfg: baseCfg,
      channel: "msteams",
      to: "user:test-user",
      payloads: [
        {
          text: "The pipeline has 3 open deals.",
        },
      ],
      skipQueue: true,
      deps: { msteams: mockSend },
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(capturedSends[0].text).toBe("The pipeline has 3 open deals.");
  });
});
