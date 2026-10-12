import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("../runtime-api.js", () => {
  return { fetchWithSsrFGuard };
});

afterEach(() => {
  fetchWithSsrFGuard.mockReset();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
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

type RoomInfoFetchParams = {
  auditContext?: string;
  init?: { headers?: { Authorization?: string } };
  timeoutMs?: number;
  url?: string;
};

function requireFirstFetchParams(): RoomInfoFetchParams {
  const [call] = fetchWithSsrFGuard.mock.calls;
  if (!call) {
    throw new Error("expected Nextcloud Talk room info fetch call");
  }
  const [fetchParams] = call;
  if (!fetchParams || typeof fetchParams !== "object" || Array.isArray(fetchParams)) {
    throw new Error("expected Nextcloud Talk room info fetch call");
  }
  return fetchParams as RoomInfoFetchParams;
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("nextcloud talk room info", () => {
  it("resolves direct rooms from the room info endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard.mockResolvedValue({
      response: jsonResponse({ ocs: { data: { type: 1 } } }),
      release,
    });

    const kind = await resolveNextcloudTalkRoomKind({
      account: lookupAccount("acct-direct"),
      roomToken: "room-direct",
    });

    expect(kind).toBe("direct");
    const fetchParams = requireFirstFetchParams();
    expect(fetchParams.url).toBe(
      "https://nc.example.com/ocs/v2.php/apps/spreed/api/v4/room/room-direct",
    );
    expect(fetchParams.auditContext).toBe("nextcloud-talk.room-info");
    expect(fetchParams.timeoutMs).toBe(30_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("caps cached room info entries", async () => {
    const cacheEntryLimit = 1000;
    fetchWithSsrFGuard.mockImplementation(async () => ({
      response: jsonResponse({ ocs: { data: { type: 1 } } }),
      release: vi.fn(async () => {}),
    }));
    const account = lookupAccount("acct-cache-cap");

    for (let index = 0; index <= cacheEntryLimit; index += 1) {
      await resolveNextcloudTalkRoomKind({
        account,
        roomToken: `room-${index}`,
      });
    }
    await resolveNextcloudTalkRoomKind({ account, roomToken: "room-0" });
    const callsAfterOldestRetry = fetchWithSsrFGuard.mock.calls.length;
    await resolveNextcloudTalkRoomKind({
      account,
      roomToken: `room-${cacheEntryLimit}`,
    });

    expect(callsAfterOldestRetry).toBe(cacheEntryLimit + 2);
    expect(fetchWithSsrFGuard.mock.calls).toHaveLength(callsAfterOldestRetry);
    expect(fetchWithSsrFGuard.mock.calls.at(-1)?.[0]).toMatchObject({
      url: "https://nc.example.com/ocs/v2.php/apps/spreed/api/v4/room/room-0",
    });
  });

  it.each([
    { type: "+01", expected: "direct" },
    { type: "1direct", expected: undefined },
    { type: -1, expected: undefined },
  ])("classifies room type $type as $expected", async ({ type, expected }) => {
    fetchWithSsrFGuard.mockResolvedValue({
      response: jsonResponse({ ocs: { data: { type } } }),
      release: vi.fn(async () => {}),
    });

    await expect(
      resolveNextcloudTalkRoomKind({
        account: lookupAccount(`type-${type}`),
        roomToken: "room-type",
      }),
    ).resolves.toBe(expected);
  });

  it("reads the api password from a file and logs non-ok room info responses", async () => {
    const release = vi.fn(async () => {});
    const runtime = createRuntimeSpies();
    const tempDir = mkdtempSync(path.join(tmpdir(), "nextcloud-talk-room-info-"));
    tempDirs.push(tempDir);
    const passwordFile = path.join(tempDir, "secret");
    writeFileSync(passwordFile, "file-secret\n", "utf-8");
    fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: false,
        status: 403,
        json: async () => ({}),
      },
      release,
    });

    const kind = await resolveNextcloudTalkRoomKind({
      account: {
        ...lookupAccount("acct-group"),
        config: { apiUser: "bot", apiPasswordFile: passwordFile },
      },
      roomToken: "room-group",
      runtime,
    });

    expect(kind).toBeUndefined();
    expect(requireFirstFetchParams().init?.headers?.Authorization).toBe(
      "Basic Ym90OmZpbGUtc2VjcmV0",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: room lookup failed (403) token=room-group",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports malformed room info JSON with a stable channel error", async () => {
    const release = vi.fn(async () => {});
    const runtime = createRuntimeSpies();
    fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const kind = await resolveNextcloudTalkRoomKind({
      account: lookupAccount("acct-malformed"),
      roomToken: "room-malformed",
      runtime,
    });

    expect(kind).toBeUndefined();
    expect(runtime.error).toHaveBeenCalledWith(
      "nextcloud-talk: room lookup error: Error: Nextcloud Talk room info failed: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined from room info without credentials or base url", async () => {
    await expect(
      resolveNextcloudTalkRoomKind({
        account: { ...lookupAccount("acct-missing"), baseUrl: "", config: {} },
        roomToken: "room-missing",
      }),
    ).resolves.toBeUndefined();

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each([408, 429, 500, 599])(
    "leaves HTTP %s retryable and fetches the room again after recovery",
    async (status) => {
      const release = vi.fn(async () => {});
      fetchWithSsrFGuard
        .mockResolvedValueOnce({ response: new Response("", { status }), release })
        .mockResolvedValueOnce({
          response: jsonResponse({ ocs: { data: { type: 6 } } }),
          release,
        });
      const params = { account: lookupAccount(`http-${status}`), roomToken: "direct" };

      await expect(resolveNextcloudTalkRoomKind(params)).rejects.toThrow(`(${status})`);
      await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBe("direct");
      await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBe("direct");

      expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
    },
  );

  it("propagates transport errors without caching them", async () => {
    const transportError = new TypeError("fetch failed");
    fetchWithSsrFGuard.mockRejectedValueOnce(transportError).mockResolvedValueOnce({
      response: jsonResponse({ ocs: { data: { type: 1 } } }),
      release: vi.fn(async () => {}),
    });
    const params = { account: lookupAccount("transport"), roomToken: "direct" };

    await expect(resolveNextcloudTalkRoomKind(params)).rejects.toBe(transportError);
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBe("direct");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("caches permanent HTTP failures for thirty seconds", async () => {
    const status = 401;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    fetchWithSsrFGuard
      .mockResolvedValueOnce({
        response: new Response("", { status }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: jsonResponse({ ocs: { data: { type: 1 } } }),
        release: vi.fn(async () => {}),
      });
    const params = { account: lookupAccount(`permanent-${status}`), roomToken: "direct" };

    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
    clock.mockReturnValue(1_700_000_029_999);
    await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1_700_000_030_000);
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

  it.each(["not-a-url", "file:///tmp/nextcloud-talk"])(
    "does not retry or fetch an invalid base URL: %s",
    async (baseUrl) => {
      const params = {
        account: { ...lookupAccount(`invalid-${baseUrl}`), baseUrl },
        roomToken: "direct",
      };
      await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
      await expect(resolveNextcloudTalkRoomKind(params)).resolves.toBeUndefined();
      expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );
});
