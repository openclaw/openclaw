import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
import { getSlackDirectorySelfLive } from "./directory-live.js";
const slackClientMocks = vi.hoisted(() => ({
  authTest: vi.fn(),
  usersInfo: vi.fn(),
  createSlackLookupClient: vi.fn(() => ({
    auth: { test: slackClientMocks.authTest },
    users: { info: slackClientMocks.usersInfo },
  })),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: slackClientMocks.createSlackLookupClient,
}));

function config(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

describe("Slack directory contract", () => {
  beforeEach(() => {
    slackClientMocks.authTest.mockReset();
    slackClientMocks.usersInfo.mockReset();
    slackClientMocks.createSlackLookupClient.mockClear();
  });

  it("uses the bounded lookup client for live directory requests", async () => {
    const fixture = "lookup-fixture";
    slackClientMocks.authTest.mockResolvedValue({ ok: true, user_id: "U123", user: "bot" });
    slackClientMocks.usersInfo.mockResolvedValue({
      ok: true,
      user: { id: "U123", name: "bot", profile: { display_name: "Bot" } },
    });

    await getSlackDirectorySelfLive({ cfg: config({ botToken: fixture }) });

    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledExactlyOnceWith(fixture);
  });

  it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
    const envSecret = {
      source: "env",
      provider: "default",
      id: "MISSING_TEST_SECRET",
    } as const;
    const cfg = config({
      botToken: envSecret,
      appToken: envSecret,
      allowFrom: ["U123"],
      channels: { C111: {} },
    });

    await expectDirectoryIds(listSlackDirectoryPeersFromConfig, cfg, ["user:u123"]);
    await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const peers = await listSlackDirectoryPeersFromConfig({
      cfg: config({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        allowFrom: ["U100", "U200"],
        dms: { U300: {} },
      }),
      accountId: "default",
      query: "user:u",
      limit: 2,
    });
    expect(peers).toHaveLength(2);
    expect(peers.every((entry) => entry.id.startsWith("user:u"))).toBe(true);
  });

  it("falls back to auth identity when live user profile lookup fails", async () => {
    slackClientMocks.authTest.mockResolvedValue({ ok: true, user_id: "USELF", user: "ada" });
    slackClientMocks.usersInfo.mockRejectedValue(new Error("missing_scope"));
    const self = await getSlackDirectorySelfLive({
      cfg: config({ userToken: "xoxp-test" }),
      accountId: "default",
    });
    expect(self).toMatchObject({ kind: "user", id: "user:USELF", name: "ada", handle: "@ada" });
  });
});
