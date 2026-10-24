import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackChannelType, resolveSlackConversationInfo } from "./channel-type.js";

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

function conversation(
  channelId: string,
  slack: NonNullable<OpenClawConfig["channels"]>["slack"] = { botToken: "xoxb-test" },
  options: Partial<Parameters<typeof resolveSlackConversationInfo>[0]> = {},
) {
  return resolveSlackConversationInfo({ cfg: slackConfig(slack), channelId, ...options });
}

function expectReadTokens(...tokens: string[]) {
  expect(createSlackReadClientMock.mock.calls).toEqual(
    tokens.map((token) => [token, { teamId: undefined }, undefined, undefined]),
  );
}

const slackClientMocks = vi.hoisted(() => {
  const conversationsInfo = vi.fn();
  const conversationsOpen = vi.fn();
  const createClient = () => ({
    conversations: { info: conversationsInfo, open: conversationsOpen },
  });
  return {
    conversationsInfo,
    conversationsOpen,
    createSlackReadClient: vi.fn(createClient),
    createSlackWebClient: vi.fn(createClient),
  };
});
const {
  conversationsInfo: conversationsInfoMock,
  conversationsOpen: conversationsOpenMock,
  createSlackReadClient: createSlackReadClientMock,
  createSlackWebClient: createSlackWebClientMock,
} = slackClientMocks;

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createSlackReadClient: slackClientMocks.createSlackReadClient,
  createSlackWebClient: slackClientMocks.createSlackWebClient,
}));

describe("resolveSlackChannelType", () => {
  beforeEach(() => {
    conversationsInfoMock.mockReset();
    conversationsOpenMock.mockReset();
    createSlackReadClientMock.mockClear();
    createSlackWebClientMock.mockClear();
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_USER_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses configured defaultAccount for omitted-account cache keys", async () => {
    const channelId = "CDEFAULTACCOUNT1";

    await expect(
      resolveSlackChannelType({ cfg: slackConfig({ enabled: true }), channelId }),
    ).resolves.toBe("unknown");

    await expect(
      resolveSlackChannelType({
        cfg: slackConfig({
          enabled: true,
          defaultAccount: "work",
          accounts: { work: { dm: { groupChannels: [channelId] } } },
        }),
        channelId,
      }),
    ).resolves.toBe("group");

    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: "read",
      env: "SLACK_USER_TOKEN",
      token: "envUsr",
      slack: { botToken: "botB" },
      channelId: "DENVUSERREAD1",
    },
    {
      operation: "write",
      env: "SLACK_BOT_TOKEN",
      token: "envBot",
      slack: { userToken: "usrB" },
      channelId: "DENVBOTWRITE1",
    },
  ] as const)(
    "uses the env credential for native IM $operation",
    async ({ operation, env, token, slack, channelId }) => {
      vi.stubEnv(env, token);
      const read = operation === "read";
      const lookup = read ? conversationsInfoMock : conversationsOpenMock;
      const createClient = read ? createSlackReadClientMock : createSlackWebClientMock;
      lookup.mockResolvedValueOnce({
        channel: { id: channelId, is_im: true, user: "U09G2DJ0275" },
      });
      await expect(
        resolveSlackConversationInfo({ cfg: slackConfig(slack), channelId, operation }),
      ).resolves.toEqual({ type: "dm", user: "U09G2DJ0275" });
      expect(createClient).toHaveBeenCalledWith(
        token,
        { teamId: undefined },
        undefined,
        ...(read ? [undefined] : []),
      );
      expect(read ? createSlackWebClientMock : createSlackReadClientMock).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledWith(
        read
          ? { channel: channelId }
          : { channel: channelId, prevent_creation: true, return_im: true },
      );
      expect(read ? conversationsOpenMock : conversationsInfoMock).not.toHaveBeenCalled();
    },
  );

  it("uses the read credential to classify C-prefixed MPIMs and returns their name", async () => {
    conversationsInfoMock.mockResolvedValueOnce({
      channel: { id: "CREADCREDENTIAL1", is_mpim: true, name: "mpdm-alice--bob-1" },
    });

    await expect(
      conversation(
        "CREADCREDENTIAL1",
        { botToken: "xoxb-writer", userToken: "xoxp-reader" },
        { operation: "read" },
      ),
    ).resolves.toEqual({ type: "group", name: "mpdm-alice--bob-1" });
    expectReadTokens("xoxp-reader");
    expect(createSlackWebClientMock).not.toHaveBeenCalled();
    expect(conversationsInfoMock).toHaveBeenCalledWith({ channel: "CREADCREDENTIAL1" });
  });

  it("does not reuse cached metadata across Slack credential rotation", async () => {
    conversationsInfoMock
      .mockResolvedValueOnce({ channel: { id: "CCREDENTIALROTATION1", name: "before-rotation" } })
      .mockResolvedValueOnce({ channel: { id: "CCREDENTIALROTATION1", name: "after-rotation" } });

    await expect(
      conversation("CCREDENTIALROTATION1", { botToken: "xoxb-before" }),
    ).resolves.toMatchObject({ name: "before-rotation" });
    await expect(
      conversation("CCREDENTIALROTATION1", { botToken: "xoxb-after" }),
    ).resolves.toMatchObject({ name: "after-rotation" });

    expectReadTokens("xoxb-before", "xoxb-after");
    expect(conversationsInfoMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes names used for authorization instead of caching them", async () => {
    conversationsInfoMock
      .mockResolvedValueOnce({ channel: { id: "CFRESHNAME1", name: "old-name" } })
      .mockResolvedValueOnce({ channel: { id: "CFRESHNAME1", name: "new-name" } });
    await expect(
      conversation("CFRESHNAME1", undefined, { requireFreshName: true }),
    ).resolves.toMatchObject({ name: "old-name" });
    await expect(
      conversation("CFRESHNAME1", undefined, { requireFreshName: true }),
    ).resolves.toMatchObject({ name: "new-name" });

    expect(conversationsInfoMock).toHaveBeenCalledTimes(2);
  });

  it("does not use configured channel entries as topology proof when Slack lookup fails", async () => {
    const channelId = "CCONFIGCHANNEL1";
    conversationsInfoMock.mockRejectedValueOnce(new Error("missing_scope"));

    await expect(
      conversation(channelId, { botToken: "xoxb-test", channels: { CCONFIGCHANNEL1: {} } }),
    ).resolves.toEqual({ type: "unknown" });
    expect(conversationsInfoMock).toHaveBeenCalledWith({ channel: channelId });
  });

  it("does not cache incomplete native IM channel lookups", async () => {
    conversationsInfoMock
      .mockRejectedValueOnce(new Error("temporary_failure"))
      .mockResolvedValueOnce({
        channel: { id: "DRETRYLOOKUP1", is_im: true, user: "U09G2DJ0275" },
      });

    await expect(conversation("DRETRYLOOKUP1")).resolves.toEqual({ type: "dm" });
    await expect(conversation("DRETRYLOOKUP1")).resolves.toEqual({
      type: "dm",
      user: "U09G2DJ0275",
    });
    expect(conversationsInfoMock).toHaveBeenCalledTimes(2);
    expect(conversationsOpenMock).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used conversation info entries after the cache limit", async () => {
    const cacheMaxEntries = 1024;
    conversationsInfoMock.mockImplementation(async ({ channel }) => ({ channel: { id: channel } }));

    for (let index = 0; index < cacheMaxEntries; index++) {
      await conversation(`C${index.toString().padStart(10, "0")}`);
    }
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries);

    await conversation("C0000000000");
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries);

    await conversation(`C${cacheMaxEntries.toString().padStart(10, "0")}`);
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 1);

    await conversation("C0000000001");
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 2);

    await conversation("C0000000000");
    expect(conversationsInfoMock).toHaveBeenCalledTimes(cacheMaxEntries + 2);
  });
});
