import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackConversationInfo } from "./channel-type.js";

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
  expect(read.mock.calls.map(([token]) => token)).toEqual(tokens);
}

const mocks = vi.hoisted(() => {
  const info = vi.fn();
  const open = vi.fn();
  const createClient = () => ({ conversations: { info, open } });
  return {
    info,
    open,
    read: vi.fn((_token: string) => createClient()),
    write: vi.fn((_token: string) => createClient()),
  };
});
const { info, open, read, write } = mocks;

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createSlackReadClient: mocks.read,
  createSlackWebClient: mocks.write,
}));

describe("resolveSlackChannelType", () => {
  beforeEach(() => {
    info.mockReset();
    open.mockReset();
    read.mockClear();
    write.mockClear();
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_USER_TOKEN", "");
  });

  it("uses configured defaultAccount for omitted-account cache keys", async () => {
    const channelId = "CDEFAULTACCOUNT1";

    await expect(conversation(channelId, { enabled: true })).resolves.toEqual({ type: "unknown" });
    await expect(
      conversation(channelId, {
        enabled: true,
        defaultAccount: "work",
        accounts: { work: { dm: { groupChannels: [channelId] } } },
      }),
    ).resolves.toEqual({ type: "group" });

    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ["read", "SLACK_USER_TOKEN", "envUsr", { botToken: "botB" }, "DENVUSERREAD1"],
    ["write", "SLACK_BOT_TOKEN", "envBot", { userToken: "usrB" }, "DENVBOTWRITE1"],
  ] as const)(
    "uses the env credential for native IM %s",
    async (operation, env, token, slack, channelId) => {
      vi.stubEnv(env, token);
      const isRead = operation === "read";
      const lookup = isRead ? info : open;
      const createClient = isRead ? read : write;
      lookup.mockResolvedValueOnce({
        channel: { id: channelId, is_im: true, user: "U09G2DJ0275" },
      });
      await expect(
        resolveSlackConversationInfo({ cfg: slackConfig(slack), channelId, operation }),
      ).resolves.toEqual({ type: "dm", user: "U09G2DJ0275" });
      expect(createClient.mock.calls.map(([usedToken]) => usedToken)).toEqual([token]);
      expect(isRead ? write : read).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledWith(
        isRead
          ? { channel: channelId }
          : { channel: channelId, prevent_creation: true, return_im: true },
      );
      expect(isRead ? open : info).not.toHaveBeenCalled();
    },
  );

  it("uses the read credential to classify C-prefixed MPIMs and returns their name", async () => {
    info.mockResolvedValueOnce({
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
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["credential rotation", "authorization refresh"])(
    "refreshes metadata for %s",
    async (reason) => {
      const channelId = reason === "credential rotation" ? "CCREDENTIALROTATION1" : "CFRESHNAME1";
      const tokens =
        reason === "credential rotation"
          ? ["xoxb-before", "xoxb-after"]
          : ["xoxb-test", "xoxb-test"];
      info
        .mockResolvedValueOnce({ channel: { id: channelId, name: "old-name" } })
        .mockResolvedValueOnce({ channel: { id: channelId, name: "new-name" } });
      for (const [index, name] of ["old-name", "new-name"].entries()) {
        await expect(
          conversation(
            channelId,
            { botToken: tokens[index] },
            {
              requireFreshName: reason === "authorization refresh",
            },
          ),
        ).resolves.toMatchObject({ name });
      }
      expectReadTokens(...tokens);
      expect(info).toHaveBeenCalledTimes(2);
    },
  );

  it("does not use configured channel entries as topology proof when Slack lookup fails", async () => {
    const channelId = "CCONFIGCHANNEL1";
    info.mockRejectedValueOnce(new Error("missing_scope"));

    await expect(
      conversation(channelId, { botToken: "xoxb-test", channels: { CCONFIGCHANNEL1: {} } }),
    ).resolves.toEqual({ type: "unknown" });
  });

  it("does not cache incomplete native IM channel lookups", async () => {
    info.mockRejectedValueOnce(new Error("temporary_failure")).mockResolvedValueOnce({
      channel: { id: "DRETRYLOOKUP1", is_im: true, user: "U09G2DJ0275" },
    });

    await expect(conversation("DRETRYLOOKUP1")).resolves.toEqual({ type: "dm" });
    await expect(conversation("DRETRYLOOKUP1")).resolves.toEqual({
      type: "dm",
      user: "U09G2DJ0275",
    });
    expect(info).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used conversation info entries after the cache limit", async () => {
    const cacheMaxEntries = 1024;
    info.mockImplementation(async ({ channel }) => ({ channel: { id: channel } }));

    for (let index = 0; index < cacheMaxEntries; index++) {
      await conversation(`C${index.toString().padStart(10, "0")}`);
    }
    expect(info).toHaveBeenCalledTimes(cacheMaxEntries);

    await conversation("C0000000000");
    expect(info).toHaveBeenCalledTimes(cacheMaxEntries);

    await conversation(`C${cacheMaxEntries.toString().padStart(10, "0")}`);
    expect(info).toHaveBeenCalledTimes(cacheMaxEntries + 1);

    await conversation("C0000000001");
    expect(info).toHaveBeenCalledTimes(cacheMaxEntries + 2);

    await conversation("C0000000000");
    expect(info).toHaveBeenCalledTimes(cacheMaxEntries + 2);
  });
});
