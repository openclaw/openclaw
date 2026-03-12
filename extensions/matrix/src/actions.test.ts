import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it } from "vitest";
import { matrixMessageActions } from "./actions.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const runtimeStub = {
  config: {
    loadConfig: () => ({}),
  },
  media: {
    loadWebMedia: async () => {
      throw new Error("not used");
    },
    mediaKindFromMime: () => "image",
    isVoiceCompatibleAudio: () => false,
    getImageMetadata: async () => null,
    resizeToJpeg: async () => Buffer.from(""),
  },
  state: {
    resolveStateDir: () => "/tmp/openclaw-matrix-test",
  },
  channel: {
    text: {
      resolveTextChunkLimit: () => 4000,
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

function createConfiguredMatrixConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        enabled: true,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
      },
    },
  } as CoreConfig;
}

describe("matrixMessageActions", () => {
  beforeEach(() => {
    setMatrixRuntime(runtimeStub);
  });

  it("exposes poll create but only handles poll votes inside the plugin", () => {
    const listActions = matrixMessageActions.listActions;
    const supportsAction = matrixMessageActions.supportsAction;

    expect(listActions).toBeTypeOf("function");
    expect(supportsAction).toBeTypeOf("function");

    const actions = listActions!({
      cfg: createConfiguredMatrixConfig(),
    } as never);

    expect(actions).toContain("poll");
    expect(actions).toContain("poll-vote");
    expect(supportsAction!({ action: "poll" } as never)).toBe(false);
    expect(supportsAction!({ action: "poll-vote" } as never)).toBe(true);
  });

  it("exposes and handles self-profile updates", () => {
    const listActions = matrixMessageActions.listActions;
    const supportsAction = matrixMessageActions.supportsAction;

    const actions = listActions!({
      cfg: createConfiguredMatrixConfig(),
    } as never);

    expect(actions).toContain("set-profile");
    expect(supportsAction!({ action: "set-profile" } as never)).toBe(true);
  });

  it("hides gated actions when the default Matrix account disables them", () => {
    const actions = matrixMessageActions.listActions!({
      cfg: {
        channels: {
          matrix: {
            defaultAccount: "assistant",
            actions: {
              messages: true,
              reactions: true,
              pins: true,
              profile: true,
              memberInfo: true,
              channelInfo: true,
              verification: true,
            },
            accounts: {
              assistant: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "token",
                encryption: true,
                actions: {
                  messages: false,
                  reactions: false,
                  pins: false,
                  profile: false,
                  memberInfo: false,
                  channelInfo: false,
                  verification: false,
                },
              },
            },
          },
        },
      } as CoreConfig,
    } as never);

    expect(actions).toEqual(["poll", "poll-vote"]);
  });

  it("hides actions until defaultAccount is set for ambiguous multi-account configs", () => {
    const actions = matrixMessageActions.listActions!({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                homeserver: "https://matrix.example.org",
                accessToken: "assistant-token",
              },
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
    } as never);

    expect(actions).toEqual([]);
  });
});
