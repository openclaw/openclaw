// Slack tests cover channel type plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSlackChannelTypeCacheForTest,
  resolveSlackChannelType,
  resolveSlackConversationInfo,
} from "./channel-type.js";

const conversationsInfoMock = vi.fn();
const conversationsOpenMock = vi.fn();

vi.mock("./client.js", () => ({
  createSlackWebClient: vi.fn(() => ({
    conversations: {
      info: conversationsInfoMock,
      open: conversationsOpenMock,
    },
  })),
}));

describe("resolveSlackChannelType", () => {
  beforeEach(() => {
    conversationsInfoMock.mockReset();
    conversationsOpenMock.mockReset();
    resetSlackChannelTypeCacheForTest();
  });

  it("uses configured defaultAccount for omitted-account cache keys", async () => {
    const channelId = "C123";

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              enabled: true,
            },
          },
        } as never,
        channelId,
      }),
    ).resolves.toBe("unknown");

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              enabled: true,
              defaultAccount: "work",
              accounts: {
                work: {
                  botToken: "xoxb-work",
                  appToken: "xapp-work",
                  dm: {
                    groupChannels: [channelId],
                  },
                },
              },
            },
          },
        } as never,
        channelId,
      }),
    ).resolves.toBe("group");

    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it("returns Slack IM peer user metadata from conversations.open", async () => {
    conversationsOpenMock.mockResolvedValueOnce({
      channel: {
        id: "D0AEWSDHAQH",
        is_im: true,
        user: "U09G2DJ0275",
      },
    });

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        } as never,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
      user: "U09G2DJ0275",
    });
    expect(conversationsOpenMock).toHaveBeenCalledWith({
      channel: "D0AEWSDHAQH",
      prevent_creation: true,
      return_im: true,
    });
    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it("keeps D-prefixed channels typed as dm when Slack lookup fails", async () => {
    conversationsOpenMock.mockRejectedValueOnce(new Error("missing_scope"));

    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        } as never,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
    });
  });

  it("does not cache incomplete native IM channel lookups", async () => {
    conversationsOpenMock
      .mockRejectedValueOnce(new Error("temporary_failure"))
      .mockResolvedValueOnce({
        channel: {
          id: "D0AEWSDHAQH",
          is_im: true,
          user: "U09G2DJ0275",
        },
      });

    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
        },
      },
    } as never;

    await expect(
      resolveSlackConversationInfo({
        cfg,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
    });
    await expect(
      resolveSlackConversationInfo({
        cfg,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
      user: "U09G2DJ0275",
    });
    expect(conversationsOpenMock).toHaveBeenCalledTimes(2);
  });

  it("does not let group-channel overrides reclassify native IM channel ids", async () => {
    await expect(
      resolveSlackConversationInfo({
        cfg: {
          channels: {
            slack: {
              dm: {
                groupChannels: ["D0AEWSDHAQH"],
              },
            },
          },
        } as never,
        channelId: "D0AEWSDHAQH",
      }),
    ).resolves.toEqual({
      type: "dm",
    });
    expect(conversationsOpenMock).not.toHaveBeenCalled();
    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used conversation info entries after the cache limit", async () => {
    const cacheMaxEntries = 1024;
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
        },
      },
    } as never;

    conversationsInfoMock.mockImplementation(async ({ channel }) => ({
      channel: {
        id: channel,
      },
    }));

    for (let index = 0; index < cacheMaxEntries; index++) {
      await resolveSlackConversationInfo({
        cfg,
        channelId: `C${index.toString().padStart(8, "0")}`,
      });
    }
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries);

    await resolveSlackConversationInfo({
      cfg,
      channelId: "C00000000",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries);

    await resolveSlackConversationInfo({
      cfg,
      channelId: `C${cacheMaxEntries.toString().padStart(8, "0")}`,
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 1);

    await resolveSlackConversationInfo({
      cfg,
      channelId: "C00000001",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 2);

    await resolveSlackConversationInfo({
      cfg,
      channelId: "C00000000",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 2);
  });

  it("preserves the channel-type wrapper contract", async () => {
    conversationsInfoMock.mockResolvedValueOnce({
      channel: {
        id: "G123",
        is_mpim: true,
      },
    });

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        } as never,
        channelId: "G123",
      }),
    ).resolves.toBe("group");
  });
});
