import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  clearGitHubCredentialVerificationCache,
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
  requestGitHubOAuthDeviceCode,
  verifyGitHubCredential,
} from "./github-oauth-client.js";

const DEVICE_CODE = "a".repeat(40);
const TOKEN = "synthetic-test-token";
let probe: MockInstance<typeof fetch>;
const jsonResponse = (body: unknown, status = 200) => Response.json(body, { status });
const reply = (body: unknown, status = 200) => probe.mockResolvedValue(jsonResponse(body, status));
const verify = (options?: Parameters<typeof verifyGitHubCredential>[1]) =>
  verifyGitHubCredential(TOKEN, options);
const poll = () => pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE });

beforeEach(() => {
  clearGitHubCredentialVerificationCache();
  probe = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

it("verifies a managed credential at a fixed origin and registers redaction", async () => {
  const login = "managed-user_org";
  probe.mockResolvedValue(
    Response.json(
      { id: 202, login, avatar_url: null },
      { headers: { "x-oauth-scopes": "read:org, repo, repo" } },
    ),
  );
  expect(await verify()).toEqual({
    status: "available",
    account: { accountId: 202, login, avatarUrl: null },
    scopes: ["read:org", "repo"],
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/user",
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(redactRegisteredSecretValues(`failed with ${TOKEN}`, () => "[REDACTED]")).toBe(
    "failed with [REDACTED]",
  );
});

it("re-probes a remotely revoked token after expiry without caching its rejection", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
  probe
    .mockResolvedValueOnce(jsonResponse({ id: 202, login: "revoked-user" }))
    .mockImplementation(async () => jsonResponse({}, 401));
  expect((await verify()).status).toBe("available");
  now.mockReturnValue(62_001);
  expect(await verify()).toEqual({ status: "unavailable" });
  expect(await verify()).toEqual({ status: "unavailable" });
  expect(probe).toHaveBeenCalledTimes(3);
});

it("serves stale facts while strict verification waits", async ({ signal }) => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const refresh = createDeferredCore<Response>();
  probe
    .mockResolvedValueOnce(jsonResponse({ id: 204, login: "display-account" }))
    .mockReturnValueOnce(refresh.promise)
    .mockResolvedValue(jsonResponse({}, 401));
  const first = await verify();
  now.mockReturnValue(61_001);
  try {
    expect(await withinTest(verify({ allowStale: true }), signal)).toEqual({
      ...first,
      stale: true,
    });
    expect(await verify({ allowStale: true })).toEqual({ ...first, stale: true });
    let settled = false;
    const strict = verify().then((result) => {
      settled = true;
      return result;
    });
    expect(settled).toBe(false);
    refresh.resolve(jsonResponse({}, 401));
    expect(await strict).toEqual({ status: "unavailable" });
    expect(await verify({ allowStale: true })).toEqual({ status: "unavailable" });
    expect(probe).toHaveBeenCalledTimes(3);
  } finally {
    refresh.resolve(jsonResponse({}, 401));
  }
});

it("keeps different tokens separate while sharing concurrent probes for one token", async () => {
  probe.mockImplementation(async (_url, init) =>
    jsonResponse({ id: 202, login: new Headers(init?.headers).get("Authorization") }),
  );
  const [first, concurrent, other] = await Promise.all([
    verifyGitHubCredential("synthetic-concurrent-a"),
    verifyGitHubCredential("synthetic-concurrent-a"),
    verifyGitHubCredential("synthetic-concurrent-b"),
  ]);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(concurrent).toBe(first);
  expect(other).not.toEqual(first);
  expect(await verifyGitHubCredential("synthetic-concurrent-b")).toBe(other);
  expect(probe).toHaveBeenCalledTimes(2);
});

it("does not let an in-flight probe repopulate cleared verification state", async () => {
  const upstream = createDeferredCore<Response>();
  probe
    .mockReturnValueOnce(upstream.promise)
    .mockImplementation(async () => jsonResponse({ id: 202, login: "after-clear" }));
  const first = verify();
  clearGitHubCredentialVerificationCache();
  const second = await verify();
  upstream.resolve(jsonResponse({ id: 202, login: "before-clear" }));
  await first;
  expect(await verify()).toBe(second);
  expect(probe).toHaveBeenCalledTimes(2);
});

it.each([
  ["HTTP 403", "synthetic-secret-diagnostics", 403],
  ["invalid-json", "not-json synthetic-token", 200],
  ["long-login", JSON.stringify({ id: 202, login: "x".repeat(101) }), 200],
  [
    "oversized-body",
    JSON.stringify({ id: 202, login: "managed-user", padding: "x".repeat(17000) }),
    200,
  ],
] as const)("rejects unverified accounts (%s)", async (_name, body, status) => {
  probe.mockResolvedValue(new Response(body, { status }));
  expect(await verify()).toEqual({ status: "unverified" });
});

it("bounds the account body read and sanitizes network and cancellation errors", async () => {
  const cancel = vi.fn();
  probe.mockResolvedValue(new Response(new ReadableStream({ cancel })));
  expect(await verify({ timeoutMs: 10 })).toEqual({ status: "unverified" });
  expect(cancel).toHaveBeenCalled();
  const caller = new AbortController();
  probe.mockImplementation(async (_url, init) => {
    caller.abort(new Error("synthetic-token must stay private"));
    expect(init?.signal?.aborted).toBe(true);
    throw init?.signal?.reason;
  });
  expect(await verify({ signal: caller.signal })).toEqual({ status: "unverified" });
});

it.each([
  ["user code", { user_code: "invalid" }],
  ["verification URI", { verification_uri: "https://example.com/login/device" }],
  ["poll interval", { interval: 0 }],
])("rejects an invalid device authorization %s", async (_name, overrides) => {
  reply({
    device_code: DEVICE_CODE,
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
    ...overrides,
  });
  await expect(requestGitHubOAuthDeviceCode()).rejects.toThrow(
    "GitHub OAuth device authorization response was invalid",
  );
});

it.each([
  ["authorization_pending", {}, { status: "authorization_pending" }],
  [
    "slow_down",
    {
      interval: 12,
      error_description: "Continue at the returned interval",
      error_uri: "https://docs.github.com/apps/oauth-apps",
    },
    {
      status: "slow_down",
      intervalSeconds: 12,
      errorDescription: "Continue at the returned interval",
      errorUri: "https://docs.github.com/apps/oauth-apps",
    },
  ],
  ["device_flow_disabled", {}, { status: "error", code: "device_flow_disabled" }],
] as const)("returns the typed polling state for %s", async (error, details, expected) => {
  reply({ error, ...details });
  await expect(poll()).resolves.toEqual(expected);
});

it("returns refresh rejection as a typed outcome", async () => {
  reply({ error: "bad_refresh_token" }, 400);
  const refreshing = refreshGitHubOAuthToken({ refreshToken: "refresh-token-current" });
  await expect(refreshing).resolves.toEqual({ status: "error", code: "bad_refresh_token" });
});

it.each([
  ["wrong token type", { token_type: "mac" }],
  ["missing publication scopes", { token_type: "bearer", scope: "repo" }],
  ["unknown error", { error: "surprise_error" }],
  ["mixed success and error", { access_token: "access-token", error: "authorization_pending" }],
])("rejects a strictly invalid %s response", async (_name, body) => {
  reply(body);
  await expect(poll()).rejects.toThrow("GitHub OAuth device token response was invalid");
});

it("combines caller cancellation with a bounded request timeout", async () => {
  const caller = new AbortController();
  const timeout = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  probe.mockImplementation(async (_url, init) => {
    expect(init?.signal?.aborted).toBe(false);
    caller.abort(new Error("cancelled"));
    expect(init?.signal?.aborted).toBe(true);
    throw init?.signal?.reason;
  });

  await expect(
    requestGitHubOAuthDeviceCode({ signal: caller.signal, timeoutMs: 1234 }),
  ).rejects.toThrow("cancelled");
  expect(timeoutSpy).toHaveBeenCalledWith(1234);
});
