import { writeFileSync } from "node:fs";
import path from "node:path";
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());

// mock-isolation: room lookup uses controlled HTTP responses without loading plugin runtime state.
vi.mock("../runtime-api.js", () => ({ fetchWithSsrFGuard }));

afterEach(() => {
  fetchWithSsrFGuard.mockReset();
});

function lookupAccount(accountId: string): ResolvedNextcloudTalkAccount {
  return {
    accountId,
    enabled: true,
    baseUrl: "https://nc.example.com",
    secret: "test-bot-secret",
    secretSource: "config",
    config: { apiUser: "bot", apiPassword: "secret" },
  };
}

const roomResponse = (type: number | string) => Response.json({ ocs: { data: { type } } });

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuard.mockResolvedValue({ response, release });
  return release;
}
function lookup(accountId: string, runtime?: RuntimeEnv) {
  return resolveNextcloudTalkRoomKind({
    account: lookupAccount(accountId),
    roomToken: `room-${accountId}`,
    runtime,
  });
}

describe("nextcloud talk room info", () => {
  it.each([
    { dimension: "server", baseUrl: "https://other.example.com" },
    { dimension: "user", config: { apiUser: "other-bot", apiPassword: "secret" } },
    { dimension: "password", config: { apiUser: "bot", apiPassword: "other-secret" } },
  ])("isolates cached room kinds by current $dimension", async ({ dimension, ...overrides }) => {
    const first = lookupAccount(`scope-${dimension}`);
    const second = { ...first, ...overrides };
    const roomToken = "shared-room";
    const firstUrl = `${first.baseUrl}/ocs/v2.php/apps/spreed/api/v4/room/${roomToken}`;
    const firstAuth = "Basic Ym90OnNlY3JldA==";
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockImplementation(async ({ url, init }) => ({
      response: roomResponse(
        url === firstUrl && new Headers(init.headers).get("Authorization") === firstAuth ? 1 : 2,
      ),
      release,
    }));
    const lookupRoom = (account: ResolvedNextcloudTalkAccount) =>
      resolveNextcloudTalkRoomKind({ account, roomToken });

    await expect(lookupRoom(first)).resolves.toBe("direct");
    await expect(lookupRoom(second)).resolves.toBe("group");
    await expect(lookupRoom(first)).resolves.toBe("direct");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);

    await expect(lookupRoom({ ...first, config: {} })).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a rejected room lookup under a different network policy", async () => {
    const account = lookupAccount("policy-scope");
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard
      .mockRejectedValueOnce(new SsrFBlockedError("blocked private network"))
      .mockResolvedValueOnce({ response: roomResponse(1), release });
    const lookupRoom = (current: ResolvedNextcloudTalkAccount) =>
      resolveNextcloudTalkRoomKind({ account: current, roomToken: "shared-room" });

    await expect(lookupRoom(account)).resolves.toBeUndefined();
    await expect(
      lookupRoom({
        ...account,
        config: { ...account.config, network: { dangerouslyAllowPrivateNetwork: true } },
      }),
    ).resolves.toBe("direct");
    await expect(lookupRoom(account)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not accept a partially numeric room type", async () => {
    mockResponse(roomResponse("1direct"));
    await expect(lookup("type-1direct")).resolves.toBeUndefined();
  });

  it("reads the api password from a file and logs non-ok room info responses", async () => {
    await withTempDir("nextcloud-talk-room-info-", async (tempDir) => {
      const runtime = createRuntimeSpies();
      const passwordFile = path.join(tempDir, "secret");
      writeFileSync(passwordFile, "file-secret\n", "utf-8");
      const release = mockResponse(new Response(null, { status: 403 }));

      const kind = await resolveNextcloudTalkRoomKind({
        account: {
          ...lookupAccount("acct-group"),
          config: { apiUser: "bot", apiPasswordFile: passwordFile },
        },
        roomToken: "room-group",
        runtime,
      });

      expect(kind).toBeUndefined();
      expect(fetchWithSsrFGuard).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          init: expect.objectContaining({
            headers: expect.objectContaining({ Authorization: "Basic Ym90OmZpbGUtc2VjcmV0" }),
          }),
        }),
      );
      expect(runtime.log).toHaveBeenCalledWith(
        "nextcloud-talk: room lookup failed (403) token=room-group",
      );
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("reports malformed room info JSON with a stable channel error", async () => {
    const runtime = createRuntimeSpies();
    const release = mockResponse(
      new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(lookup("acct-malformed", runtime)).resolves.toBeUndefined();
    expect(runtime.error).toHaveBeenCalledWith(
      "nextcloud-talk: room lookup error: Error: Nextcloud Talk room info failed: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined from room info without credentials or base url", async () => {
    const account = { ...lookupAccount("acct-missing"), baseUrl: "", config: {} };
    await expect(
      resolveNextcloudTalkRoomKind({ account, roomToken: "room-missing" }),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("leaves HTTP 599 retryable and fetches the room again after recovery", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard
      .mockResolvedValueOnce({ response: new Response("", { status: 599 }), release })
      .mockResolvedValueOnce({ response: roomResponse(6), release });
    const params = { account: lookupAccount("http-599"), roomToken: "direct" };

    await expect(resolveNextcloudTalkRoomKind(params)).rejects.toThrow("(599)");
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBe("direct");
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBe("direct");

    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("propagates transport errors without caching them", async () => {
    const transportError = new TypeError("fetch failed");
    fetchWithSsrFGuard.mockRejectedValueOnce(transportError).mockResolvedValueOnce({
      response: roomResponse(1),
      release: vi.fn(async () => {}),
    });
    const params = { account: lookupAccount("transport"), roomToken: "direct" };

    await expect(resolveNextcloudTalkRoomKind(params)).rejects.toBe(transportError);
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBe("direct");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("keeps security-policy rejection on the cached fallback path", async () => {
    fetchWithSsrFGuard.mockRejectedValue(new SsrFBlockedError("blocked private network"));
    const params = { account: lookupAccount("policy"), roomToken: "direct" };

    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
  });

  it("does not retry or fetch a file URL", async () => {
    const baseUrl = "file:///tmp/nextcloud-talk";
    const params = {
      account: { ...lookupAccount(`invalid-${baseUrl}`), baseUrl },
      roomToken: "direct",
    };
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
