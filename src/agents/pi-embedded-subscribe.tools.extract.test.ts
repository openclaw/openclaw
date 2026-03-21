import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTelegramMessagingTarget } from "../../extensions/telegram/api.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractMessagingToolSend,
  extractToolMediaArtifact,
} from "./pi-embedded-subscribe.tools.js";

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { normalizeTarget: normalizeTelegramMessagingTarget },
          },
          source: "test",
        },
      ]),
    );
  });

  it("uses channel as provider for message tool", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("prefers provider when both provider and channel are set", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "slack",
      channel: "telegram",
      to: "channel:C1",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("slack");
    expect(result?.to).toBe("channel:C1");
  });

  it("accepts target alias when to is omitted", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      target: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });
});

describe("extractToolMediaArtifact", () => {
  it("keeps local media paths for trusted core tools", () => {
    expect(
      extractToolMediaArtifact("image_generate", {
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("drops local media paths for untrusted tools", () => {
    expect(
      extractToolMediaArtifact("third_party_plugin", {
        details: {
          media: {
            mediaUrls: ["/tmp/secret.png"],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps remote media urls for untrusted tools", () => {
    expect(
      extractToolMediaArtifact("third_party_plugin", {
        details: {
          media: {
            mediaUrls: ["https://example.com/generated.png"],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["https://example.com/generated.png"],
    });
  });

  it("extracts audioAsVoice from media artifact", () => {
    expect(
      extractToolMediaArtifact("tts", {
        details: {
          media: {
            mediaUrl: "/tmp/voice.opus",
            audioAsVoice: true,
          },
        },
      }),
    ).toEqual({
      mediaUrl: "/tmp/voice.opus",
      audioAsVoice: true,
    });
  });

  it("returns undefined when no media field exists", () => {
    expect(
      extractToolMediaArtifact("bash", {
        content: [{ type: "text", text: "done" }],
        details: { status: "ok" },
      }),
    ).toBeUndefined();
  });
});
