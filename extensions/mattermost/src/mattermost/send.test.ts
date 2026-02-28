import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for channel-name → channel-ID resolution in Mattermost send flow.
 *
 * Covers the fix for openclaw/openclaw#29691 where `parseMattermostTarget`
 * treated a channel name (e.g. "finance") as a channel ID, causing
 * `createMattermostPost` to send `channel_id: "finance"` → 403.
 */

// ---------------------------------------------------------------------------
// 1. Unit tests for parseMattermostTarget & isMattermostId (exported helpers)
// ---------------------------------------------------------------------------

// We re-implement the helpers here because they are module-private.
// If they are later exported, replace with direct imports.

function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/i.test(value);
}

describe("isMattermostId", () => {
  it("accepts a valid 26-char alphanumeric Mattermost ID", () => {
    expect(isMattermostId("x64h4o7nubyf5dymu95pa3ci9c")).toBe(true);
  });

  it("rejects a channel name", () => {
    expect(isMattermostId("finance")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isMattermostId("")).toBe(false);
  });

  it("rejects a 26-char string with special characters", () => {
    expect(isMattermostId("x64h4o7nubyf5dymu95pa3ci_c")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Integration test — sendMessageMattermost resolves channel names
// ---------------------------------------------------------------------------

// Mock the runtime so sendMessageMattermost can be imported without side-effects.
vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    logging: {
      getChildLogger: () => ({ debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    config: {
      loadConfig: () => ({
        channels: {
          mattermost: {
            accounts: {
              default: {
                botToken: "mock-bot-token",
                baseUrl: "https://chat.example.com",
              },
            },
          },
        },
      }),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "pipe",
        convertMarkdownTables: (text: string) => text,
      },
      activity: { record: vi.fn() },
    },
    media: { loadWebMedia: vi.fn() },
  }),
}));

// Mock the client module to intercept API calls
vi.mock("./client.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createMattermostClient: vi.fn(() => ({
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "mock-bot-token",
      request: vi.fn(),
    })),
    fetchMattermostMe: vi.fn(async () => ({
      id: "bot-user-id-00000000000000",
      username: "bot",
    })),
    fetchMattermostMyTeams: vi.fn(async () => [
      { id: "team-id-00000000000000000", name: "default" },
    ]),
    fetchMattermostChannelByName: vi.fn(async (_client: unknown, _teamId: string, name: string) => {
      if (name === "finance") {
        return { id: "resolved-channel-id-0000000", name: "finance" };
      }
      throw new Error("Channel not found");
    }),
    createMattermostPost: vi.fn(
      async (_client: unknown, params: { channelId: string; message: string }) => {
        // Verify the channelId is the resolved ID, not the name
        return { id: "post-id-000000000000000000", channel_id: params.channelId };
      },
    ),
  };
});

describe("sendMessageMattermost — channel name resolution", () => {
  let sendMessageMattermost: typeof import("./send.js").sendMessageMattermost;
  let createMattermostPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const sendModule = await import("./send.js");
    sendMessageMattermost = sendModule.sendMessageMattermost;
    const clientModule = await import("./client.js");
    createMattermostPost = clientModule.createMattermostPost as ReturnType<typeof vi.fn>;
  });

  it("resolves channel name to ID before posting (channel:finance → resolved ID)", async () => {
    const result = await sendMessageMattermost("channel:finance", "Hello finance team");

    expect(createMattermostPost).toHaveBeenCalledTimes(1);
    const callArgs = createMattermostPost.mock.calls[0][1];
    expect(callArgs.channelId).toBe("resolved-channel-id-0000000");
    expect(callArgs.message).toBe("Hello finance team");
    expect(result.channelId).toBe("resolved-channel-id-0000000");
  });

  it("passes through a valid 26-char channel ID without API lookup", async () => {
    const validId = "x64h4o7nubyf5dymu95pa3ci9c";
    const result = await sendMessageMattermost(`channel:${validId}`, "Direct ID test");

    expect(createMattermostPost).toHaveBeenCalledTimes(1);
    const callArgs = createMattermostPost.mock.calls[0][1];
    expect(callArgs.channelId).toBe(validId);
    expect(result.channelId).toBe(validId);

    // fetchMattermostMyTeams should NOT have been called for a valid ID
    const clientModule = await import("./client.js");
    expect(clientModule.fetchMattermostMyTeams).not.toHaveBeenCalled();
  });

  it("strips leading # from channel names", async () => {
    const result = await sendMessageMattermost("channel:#finance", "With hash");

    expect(createMattermostPost).toHaveBeenCalledTimes(1);
    const callArgs = createMattermostPost.mock.calls[0][1];
    expect(callArgs.channelId).toBe("resolved-channel-id-0000000");
  });

  it("strips leading ~ from channel names", async () => {
    const result = await sendMessageMattermost("channel:~finance", "With tilde");

    expect(createMattermostPost).toHaveBeenCalledTimes(1);
    const callArgs = createMattermostPost.mock.calls[0][1];
    expect(callArgs.channelId).toBe("resolved-channel-id-0000000");
  });

  it("throws when channel name cannot be resolved", async () => {
    await expect(sendMessageMattermost("channel:nonexistent", "Should fail")).rejects.toThrow(
      /Cannot resolve channel name/,
    );
  });
});
