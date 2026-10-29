import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  parseMattermostTarget,
  resolveMattermostOpaqueTarget,
  type MattermostTarget,
} from "./target-resolution.js";

const {
  resolveMattermostAccount,
  createMattermostClient,
  fetchMattermostUser,
  fetchMattermostChannel,
  normalizeMattermostBaseUrl,
} = vi.hoisted(() => ({
  resolveMattermostAccount: vi.fn(),
  createMattermostClient: vi.fn(),
  fetchMattermostUser: vi.fn(),
  fetchMattermostChannel: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((value: string | undefined) => value?.trim()),
}));
const fixtureClient = (token = "token", baseUrl = "https://mm.example.com"): MattermostClient => ({
  token,
  baseUrl,
  apiBaseUrl: `${baseUrl}/api/v4`,
  request: vi.fn(),
  fetchImpl: vi.fn(),
});

async function expectRepeatedResolution(input: string, kind: "channel" | "group") {
  const params = { input, client: fixtureClient() };
  const expected = { kind, to: `channel:${input}` };
  await expect(resolveMattermostOpaqueTarget(params)).resolves.toEqual(expected);
  await expect(resolveMattermostOpaqueTarget(params)).resolves.toEqual(expected);
}

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount,
}));

vi.mock("./client.js", async () => ({
  parseMattermostApiStatus: (await vi.importActual<typeof import("./client.js")>("./client.js"))
    .parseMattermostApiStatus,
  createMattermostClient,
  fetchMattermostUser,
  fetchMattermostChannel,
  normalizeMattermostBaseUrl,
}));

describe("mattermost target resolution", () => {
  beforeEach(() => {
    resolveMattermostAccount.mockReset();
    createMattermostClient.mockReset();
    fetchMattermostUser.mockReset();
    fetchMattermostChannel.mockReset();
  });

  it.each<[string, MattermostTarget]>([
    ["abcd1234abcd1234abcd1234ab", { kind: "channel", id: "abcd1234abcd1234abcd1234ab" }],
    ["channel:abcd1234abcd1234abcd1234ab", { kind: "channel", id: "abcd1234abcd1234abcd1234ab" }],
    ["short", { kind: "channel-name", name: "short" }],
    [" CHANNEL: #General ", { kind: "channel-name", name: "General" }],
    [
      "channel:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      { kind: "channel-name", name: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    ],
    ["channel:##general", { kind: "channel-name", name: "#general" }],
    ["channel:@alice", { kind: "channel-name", name: "@alice" }],
    ["channel:user:abc", { kind: "channel-name", name: "user:abc" }],
    ["channel:mattermost:abc", { kind: "channel-name", name: "mattermost:abc" }],
    ["channel:channel:general", { kind: "channel-name", name: "channel:general" }],
    [" USER: abc ", { kind: "user", id: "abc" }],
    ["mattermost:abc", { kind: "user", id: "abc" }],
    [" @alice ", { kind: "user", username: "alice" }],
  ])("parses target %j without reinterpreting channel names", (input, expected) => {
    expect(parseMattermostTarget(input)).toEqual(expected);
  });

  it.each([
    ["", "Recipient is required"],
    ["#", "Channel name is required"],
    ["@", "Username is required"],
    ["channel: ", "Channel id is required for Mattermost sends"],
    ["channel: # ", "Channel name is required for Mattermost sends"],
    ["user: ", "User id is required for Mattermost sends"],
    ["mattermost: ", "User id is required for Mattermost sends"],
  ])("rejects empty explicit target %j", (input, message) => {
    expect(() => parseMattermostTarget(input)).toThrow(message);
  });

  it("skips explicit targets before account resolution", async () => {
    await expect(
      resolveMattermostOpaqueTarget({ input: "mattermost:chan", cfg: {} }),
    ).resolves.toBeNull();
    expect(resolveMattermostAccount).not.toHaveBeenCalled();
    expect(createMattermostClient).not.toHaveBeenCalled();
  });

  it("does not cache non-404 lookup failures", async () => {
    fetchMattermostUser.mockRejectedValue(new Error("other error"));
    const params = {
      input: "defg1234abcd1234abcd1234ab",
      client: fixtureClient(),
    };

    await expect(resolveMattermostOpaqueTarget(params)).resolves.toMatchObject({ kind: "channel" });
    await expect(resolveMattermostOpaqueTarget(params)).resolves.toMatchObject({ kind: "channel" });
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
  });

  it("falls back to channel when the channel lookup fails", async () => {
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockRejectedValue(new Error("Mattermost API 500"));
    await expectRepeatedResolution("fail1234abcd1234abcd1234ab", "channel");
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
    expect(fetchMattermostChannel).toHaveBeenCalledTimes(2);
    fetchMattermostChannel.mockResolvedValue({ type: "P" });
    await expect(
      resolveMattermostOpaqueTarget({
        input: "fail1234abcd1234abcd1234ab",
        client: fixtureClient(),
      }),
    ).resolves.toMatchObject({ kind: "group" });
    expect(fetchMattermostChannel).toHaveBeenCalledTimes(3);
  });

  it("coalesces cold lookups only within the same credential and server", async () => {
    const release = createDeferred<void>();
    const input = "j".repeat(26);
    fetchMattermostUser.mockImplementation(async () => {
      await release.promise;
      return { id: input };
    });
    const client = fixtureClient("joined-token");
    const pending = [
      resolveMattermostOpaqueTarget({ input, client }),
      resolveMattermostOpaqueTarget({ input, client }),
      resolveMattermostOpaqueTarget({ input, client: fixtureClient("other-token") }),
      resolveMattermostOpaqueTarget({
        input,
        client: fixtureClient("joined-token", "https://other.example.com"),
      }),
    ];
    release.resolve();
    expect(fetchMattermostUser).toHaveBeenCalledTimes(3);
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({ kind: "user", to: `user:${input}` })),
    );
    await expect(resolveMattermostOpaqueTarget({ input, client })).resolves.toEqual({
      kind: "user",
      to: `user:${input}`,
    });
    expect(fetchMattermostUser).toHaveBeenCalledTimes(3);
  });
});
