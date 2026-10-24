import { writeFileSync } from "node:fs";
import path from "node:path";
import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { createAccount } from "./inbound-media.test-fixtures.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());

// mock-isolation: room lookup uses controlled HTTP responses without loading plugin runtime state.
vi.mock("../runtime-api.js", () => ({ fetchWithSsrFGuard }));

afterEach(() => {
  fetchWithSsrFGuard.mockReset();
});

function lookupAccount(accountId: string): ResolvedNextcloudTalkAccount {
  return createAccount({
    accountId,
    baseUrl: "https://nc.example.com",
    config: { apiUser: "bot", apiPassword: "secret" },
  });
}

const roomResponse = (type: number | string) => Response.json({ ocs: { data: { type } } });

function mockResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuard.mockResolvedValue({ response, release });
  return release;
}
function lookup(account: string | ResolvedNextcloudTalkAccount, runtime?: RuntimeEnv) {
  return resolveNextcloudTalkRoomKind({
    account: typeof account === "string" ? lookupAccount(account) : account,
    roomToken: "shared-room",
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
    await expect(lookup(first)).resolves.toBe("direct");
    await expect(lookup(second)).resolves.toBe("group");
    await expect(lookup(first)).resolves.toBe("direct");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);

    await expect(lookup({ ...first, config: {} })).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a rejected room lookup under a different network policy", async () => {
    const account = lookupAccount("policy-scope");
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard
      .mockRejectedValueOnce(new SsrFBlockedError("blocked private network"))
      .mockResolvedValueOnce({ response: roomResponse(1), release });
    await expect(lookup(account)).resolves.toBeUndefined();
    await expect(
      lookup({
        ...account,
        config: { ...account.config, network: { dangerouslyAllowPrivateNetwork: true } },
      }),
    ).resolves.toBe("direct");
    await expect(lookup(account)).resolves.toBeUndefined();
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
    await expect(lookup(account)).resolves.toBeUndefined();

    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("leaves HTTP 599 retryable and fetches the room again after recovery", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuard
      .mockResolvedValueOnce({ response: new Response("", { status: 599 }), release })
      .mockResolvedValueOnce({ response: roomResponse(6), release });
    await expect(lookup("http-599")).rejects.toThrow("(599)");
    await expect(lookup("http-599")).resolves.toBe("direct");
    await expect(lookup("http-599")).resolves.toBe("direct");

    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("propagates transport errors without caching them", async () => {
    const transportError = new TypeError("fetch failed");
    fetchWithSsrFGuard.mockRejectedValueOnce(transportError).mockResolvedValueOnce({
      response: roomResponse(1),
      release: vi.fn(async () => {}),
    });
    await expect(lookup("transport")).rejects.toBe(transportError);
    await expect(lookup("transport")).resolves.toBe("direct");
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
  });

  it("does not retry or fetch a file URL", async () => {
    const baseUrl = "file:///tmp/nextcloud-talk";
    const account = { ...lookupAccount(`invalid-${baseUrl}`), baseUrl };
    await expect(lookup(account)).resolves.toBeUndefined();
    await expect(lookup(account)).resolves.toBeUndefined();
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});

const { probeNextcloudTalkBotResponseFeature } = await import("./bot-preflight.js");

const apiConfig = {
  apiUser: "admin",
  apiPassword: "app-password",
  webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
};

function probe(config: NonNullable<Parameters<typeof createAccount>[0]>["config"] = apiConfig) {
  return probeNextcloudTalkBotResponseFeature({ account: createAccount({ config }) });
}

function mockBotResponse(response: Response): void {
  fetchWithSsrFGuard.mockResolvedValueOnce({
    response,
    release: async () => {},
    finalUrl: "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/admin",
  });
}

function mockBotAdmin(features: number | string): void {
  const bot = { id: 7, name: "OpenClaw", url: apiConfig.webhookPublicUrl, features };
  mockBotResponse(Response.json({ ocs: { data: [bot] } }));
}

describe("probeNextcloudTalkBotResponseFeature", () => {
  it.each([
    [11, true, 11],
    [9, false, 9],
    ["2response", false, undefined],
  ] as const)("checks response feature %s", async (input, ok, features) => {
    mockBotAdmin(input);
    await expect(probe()).resolves.toEqual({
      ok,
      code: ok ? "ok" : "missing_response_feature",
      botId: "7",
      botName: "OpenClaw",
      features,
      message: ok
        ? 'Nextcloud Talk bot "OpenClaw" has the response feature.'
        : `Nextcloud Talk bot "OpenClaw" (7) is missing the response feature${features === undefined ? "" : ` (features=${features})`}; outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction 7 1 or reinstall the bot with --feature response.`,
    });
  });

  it("reports malformed bot admin JSON with a stable channel error", async () => {
    mockBotResponse(
      new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(probe()).resolves.toEqual({
      ok: false,
      code: "request_failed",
      message:
        "Nextcloud Talk bot response feature check failed: Nextcloud Talk bot response feature check failed: malformed JSON response",
    });
  });

  it("bounds bot admin error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(
      `${"nextcloud bot admin failure ".repeat(1024)}tail`,
      {
        status: 503,
        headers: { "content-type": "text/plain" },
      },
    );
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    mockBotResponse(tracked.response);

    await expect(probe()).resolves.toEqual({
      ok: false,
      code: "api_error",
      status: 503,
      message: "Nextcloud Talk bot response feature check failed (503)",
    });
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("skips when API credentials are absent", async () => {
    await expect(
      probe({ ...apiConfig, apiUser: undefined, apiPassword: undefined }),
    ).resolves.toEqual({
      ok: true,
      skipped: true,
      code: "missing_api_credentials",
      message:
        "Nextcloud Talk bot response feature check skipped: apiUser/apiPassword are not configured.",
    });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
