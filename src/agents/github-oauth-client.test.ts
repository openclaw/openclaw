import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  clearGitHubCredentialVerificationCache,
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
  requestGitHubOAuthDeviceCode,
  verifyGitHubCredential,
} from "./github-oauth-client.js";

const GITHUB_CREDENTIAL_VERIFICATION_TTL_MS = 60_000;

const DEVICE_CODE = "a".repeat(40);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access-token",
    token_type: "bearer",
    scope: "workflow,repo,read:org,gist repo",
    expires_in: 28_800,
    refresh_token: "refresh-token-next",
    refresh_token_expires_in: 15_897_600,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

describe("GitHub OAuth client", () => {
  it("verifies a managed credential at a fixed origin and registers redaction", async () => {
    const login = "managed-user_org";
    const token = `synthetic-bound-credential-${login}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 202,
          login,
          avatar_url: null,
        }),
        { headers: { "x-oauth-scopes": "read:org, repo, repo" } },
      ),
    );
    expect(await verifyGitHubCredential(token)).toEqual({
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
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      }),
    );
    expect(redactRegisteredSecretValues(`failed with ${token}`, () => "[REDACTED]")).toBe(
      "failed with [REDACTED]",
    );
  });

  it("re-probes a remotely revoked token after expiry without caching its rejection", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: 202, login: "revoked-user" }))
      .mockImplementation(async () => jsonResponse({}, 401));
    expect((await verifyGitHubCredential("synthetic-revoked-token")).status).toBe("available");
    now.mockReturnValue(2_000 + GITHUB_CREDENTIAL_VERIFICATION_TTL_MS + 1);
    expect(await verifyGitHubCredential("synthetic-revoked-token")).toEqual({
      status: "unavailable",
    });
    expect(await verifyGitHubCredential("synthetic-revoked-token")).toEqual({
      status: "unavailable",
    });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("serves stale display facts while strict verification waits for revocation", async ({
    signal,
  }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const refresh = createDeferredCore<Response>();
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: 204, login: "display-account" }))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValue(jsonResponse({}, 401));
    const token = "synthetic-stale-display-token";
    const first = await verifyGitHubCredential(token);
    now.mockReturnValue(61_001);
    try {
      expect(await withinTest(verifyGitHubCredential(token, { allowStale: true }), signal)).toEqual(
        { ...first, stale: true },
      );
      expect(await verifyGitHubCredential(token, { allowStale: true })).toEqual({
        ...first,
        stale: true,
      });
      let settled = false;
      const strict = verifyGitHubCredential(token).then((result) => {
        settled = true;
        return result;
      });
      expect(settled).toBe(false);
      refresh.resolve(jsonResponse({}, 401));
      expect(await strict).toEqual({ status: "unavailable" });
      expect(await verifyGitHubCredential(token, { allowStale: true })).toEqual({
        status: "unavailable",
      });
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      refresh.resolve(jsonResponse({}, 401));
    }
  });

  it("keeps different tokens separate while sharing concurrent probes for one token", async () => {
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) =>
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
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(upstream.promise)
      .mockImplementation(async () => jsonResponse({ id: 202, login: "after-clear" }));
    const first = verifyGitHubCredential("synthetic-inflight-clear");
    clearGitHubCredentialVerificationCache();
    const second = await verifyGitHubCredential("synthetic-inflight-clear");
    upstream.resolve(jsonResponse({ id: 202, login: "before-clear" }));
    await first;
    expect(await verifyGitHubCredential("synthetic-inflight-clear")).toBe(second);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each([{ code: 403, headers: new Headers(), status: "unverified" }])(
    "classifies account HTTP $code as $status without reflecting diagnostics",
    async ({ code, headers, status }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("synthetic-secret-diagnostics", { status: code, headers }),
      );
      const token = `synthetic-http-${code}-${status}-${headers.get("retry-after") ?? headers.get("x-ratelimit-remaining") ?? "none"}`;
      expect(await verifyGitHubCredential(token)).toEqual({ status });
    },
  );

  it("verifies enterprise credentials at the configured API origin", async () => {
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: 303, login: "enterprise-user", avatar_url: null }));
    await expect(
      verifyGitHubCredential("synthetic-enterprise-token", {
        apiBaseUrl: "https://api.fixture.ghe.com",
      }),
    ).resolves.toMatchObject({
      status: "available",
      account: { accountId: 303, login: "enterprise-user" },
    });
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      "https://api.fixture.ghe.com/user",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps ordinary credential verification on public GitHub when an App API is configured", async () => {
    vi.stubEnv("GITHUB_API_BASE_URL", "https://api.fixture.ghe.com");
    try {
      const probe = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ id: 304, login: "public-user", avatar_url: null }));
      await expect(
        verifyGitHubCredential("synthetic-public-token-with-enterprise-app"),
      ).resolves.toMatchObject({ status: "available", account: { accountId: 304 } });
      expect(probe).toHaveBeenCalledExactlyOnceWith(
        "https://api.github.com/user",
        expect.objectContaining({ method: "GET" }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["invalid-json", "not-json synthetic-token"],
    ["long-login", JSON.stringify({ id: 202, login: "x".repeat(101) })],
    [
      "oversized-body",
      JSON.stringify({ id: 202, login: "managed-user", padding: "x".repeat(17000) }),
    ],
  ])(
    "rejects malformed or unbounded %s account responses without diagnostics",
    async (name, body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
      expect(await verifyGitHubCredential(`synthetic-${name}`)).toEqual({ status: "unverified" });
    },
  );

  it("bounds the account body read and sanitizes network and cancellation errors", async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel })));
    expect(await verifyGitHubCredential("synthetic-body-timeout", { timeoutMs: 10 })).toEqual({
      status: "unverified",
    });
    expect(cancel).toHaveBeenCalled();
    const caller = new AbortController();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      caller.abort(new Error("synthetic-token must stay private"));
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    expect(
      await verifyGitHubCredential("synthetic-cancellation", { signal: caller.signal }),
    ).toEqual({
      status: "unverified",
    });
  });

  it.each([
    ["user code", { user_code: "invalid" }],
    ["verification URI", { verification_uri: "https://example.com/login/device" }],
    ["poll interval", { interval: 0 }],
  ])("rejects an invalid device authorization %s", async (_name, overrides) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        device_code: DEVICE_CODE,
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
        ...overrides,
      }),
    );

    await expect(requestGitHubOAuthDeviceCode()).rejects.toThrow(
      "GitHub OAuth device authorization response was invalid",
    );
  });

  it.each([
    {
      body: { error: "authorization_pending" },
      expected: { status: "authorization_pending" },
    },
    {
      body: {
        error: "slow_down",
        interval: 12,
        error_description: "Continue at the returned interval",
        error_uri: "https://docs.github.com/apps/oauth-apps",
      },
      expected: {
        status: "slow_down",
        intervalSeconds: 12,
        errorDescription: "Continue at the returned interval",
        errorUri: "https://docs.github.com/apps/oauth-apps",
      },
    },
    {
      body: { error: "device_flow_disabled" },
      expected: { status: "error", code: "device_flow_disabled" },
    },
  ])("returns the typed polling state for $body.error", async ({ body, expected }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));

    await expect(pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE })).resolves.toEqual(
      expected,
    );
  });

  it("returns refresh rejection as a typed outcome", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "bad_refresh_token" }, 400),
    );

    await expect(
      refreshGitHubOAuthToken({ refreshToken: "refresh-token-current" }),
    ).resolves.toEqual({
      status: "error",
      code: "bad_refresh_token",
    });
  });

  it.each([
    ["wrong token type", tokenPair({ token_type: "mac" })],
    ["missing publication scopes", tokenPair({ scope: "repo" })],
    ["unknown error", { error: "surprise_error" }],
    ["mixed success and error", { ...tokenPair(), error: "authorization_pending" }],
  ])("rejects a strictly invalid %s response", async (_name, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));

    await expect(pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE })).rejects.toThrow(
      "GitHub OAuth device token response was invalid",
    );
  });

  it("combines caller cancellation with a bounded request timeout", async () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
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
});
