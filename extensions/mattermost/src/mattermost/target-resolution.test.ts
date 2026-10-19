import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { parseMattermostTarget, resolveMattermostOpaqueTarget } from "./target-resolution.js";

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
const directoryConfig = { channels: { mattermost: {} } };
const directoryAccount = (accountId: string, enabled = true) => ({
  accountId,
  enabled,
  baseUrl: "https://mm.example.com",
  botToken: "token",
  config: {},
});

async function expectRepeatedResolution(input: string, kind: "channel" | "group") {
  const params = { input, client: fixtureClient() };
  const expected = { kind, id: input, to: `channel:${input}` };
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
    normalizeMattermostBaseUrl.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recognizes ID-shaped values", () => {
    expect(parseMattermostTarget("abcd1234abcd1234abcd1234ab")).toEqual({
      kind: "channel",
      id: "abcd1234abcd1234abcd1234ab",
    });
    expect(parseMattermostTarget("short")).toEqual({ kind: "channel-name", name: "short" });
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

  it("resolves public channels (type O) as channel and caches the result", async () => {
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockResolvedValue({ id: "bcde1234abcd1234abcd1234ab", type: "O" });
    await expectRepeatedResolution("bcde1234abcd1234abcd1234ab", "channel");
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);
  });

  it("refreshes an authoritative classification after its cache TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchMattermostUser.mockResolvedValue({ id: "ttl-user" });
    const params = {
      input: "ttll1234abcd1234abcd1234ab",
      client: fixtureClient("ttl-token"),
    };

    await resolveMattermostOpaqueTarget(params);
    await resolveMattermostOpaqueTarget(params);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await resolveMattermostOpaqueTarget(params);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
  });

  it("resolves private channels (type P) as group, keeping a channel:<id> wire target", async () => {
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockResolvedValue({ id: "priv1234abcd1234abcd1234ab", type: "P" });
    await expectRepeatedResolution("priv1234abcd1234abcd1234ab", "group");
    expect(fetchMattermostChannel).toHaveBeenCalledTimes(1);
  });

  it("falls back to channel when the channel lookup fails", async () => {
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockRejectedValue(new Error("Mattermost API 500"));
    await expectRepeatedResolution("fail1234abcd1234abcd1234ab", "channel");
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
    expect(fetchMattermostChannel).toHaveBeenCalledTimes(2);
  });

  it("uses the configured account for directory discovery", async () => {
    createMattermostClient.mockReturnValue(fixtureClient());
    resolveMattermostAccount.mockReturnValue(directoryAccount("acct-1"));
    fetchMattermostUser.mockResolvedValue({ id: "cdef1234abcd1234abcd1234ab" });
    const input = "cdef1234abcd1234abcd1234ab";

    await resolveMattermostOpaqueTarget({
      input,
      cfg: directoryConfig,
      accountId: "acct-1",
    });

    expect(resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: directoryConfig,
      accountId: "acct-1",
    });
  });

  it("rejects disabled accounts before cache or provider access", async () => {
    resolveMattermostAccount.mockReturnValue(directoryAccount("disabled", false));

    await expect(
      resolveMattermostOpaqueTarget({
        input: "disabled12abcd1234abcd1234",
        cfg: directoryConfig,
        accountId: "disabled",
      }),
    ).rejects.toThrow('Mattermost account "disabled" is disabled');

    expect(normalizeMattermostBaseUrl).not.toHaveBeenCalled();
    expect(createMattermostClient).not.toHaveBeenCalled();
    expect(fetchMattermostUser).not.toHaveBeenCalled();
  });
});
