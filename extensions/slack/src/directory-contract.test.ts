import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
import { getSlackDirectorySelfLive } from "./directory-live.js";

const { authTest, usersInfo, createClient } = vi.hoisted(() => ({
  authTest: vi.fn(),
  usersInfo: vi.fn(),
  createClient: vi.fn(),
}));
// mock-isolation: directory requests use the fixture client instead of real Slack network clients.
vi.mock("./client.js", () => ({ createSlackLookupClient: createClient }));

function config(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}
beforeEach(() => {
  authTest.mockReset().mockResolvedValue({ ok: true, user_id: "USELF", user: "ada" });
  usersInfo.mockReset();
  createClient
    .mockReset()
    .mockReturnValue({ auth: { test: authTest }, users: { info: usersInfo } });
});

it("uses the bounded lookup client for live directory requests", async () => {
  usersInfo.mockResolvedValue({
    ok: true,
    user: { id: "USELF", name: "ada", profile: { display_name: "Ada" } },
  });
  await getSlackDirectorySelfLive({ cfg: config({ botToken: "lookup-fixture" }) });
  expect(createClient).toHaveBeenCalledExactlyOnceWith("lookup-fixture");
});

it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
  const secret = { source: "env", provider: "default", id: "MISSING_TEST_SECRET" } as const;
  const cfg = config({
    botToken: secret,
    appToken: secret,
    allowFrom: ["U123"],
    channels: { C111: {} },
  });
  await expectDirectoryIds(listSlackDirectoryPeersFromConfig, cfg, ["user:u123"]);
  await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
});

it("applies query and limit filtering for config-backed directories", async () => {
  const peers = await listSlackDirectoryPeersFromConfig({
    cfg: config({ allowFrom: ["U100", "U200"], dms: { U300: {} } }),
    accountId: "default",
    query: "user:u",
    limit: 2,
  });
  expect(peers).toHaveLength(2);
  expect(peers.every((entry) => entry.id.startsWith("user:u"))).toBe(true);
});

it("falls back to auth identity when live user profile lookup fails", async () => {
  usersInfo.mockRejectedValue(new Error("missing_scope"));
  const self = await getSlackDirectorySelfLive({
    cfg: config({ userToken: "xoxp-test" }),
    accountId: "default",
  });
  expect(self).toMatchObject({ kind: "user", id: "user:USELF", name: "ada", handle: "@ada" });
});
