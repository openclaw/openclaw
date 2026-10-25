import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRequestUrl } from "../plugin-sdk/request-url.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthStore } from "./mcp-oauth-store.js";
import * as oauthStore from "./mcp-oauth-store.js";
import { resolveMcpOAuthAccessToken } from "./mcp-oauth.js";
import { seedMcpOAuthStoreForTest } from "./mcp-oauth.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const identity = operatorMcpOAuthIdentity("Refresh fixture", "https://mcp.example.test/mcp");
const issuer = "https://auth.example.test";
const endpoint = issuer + "/token";
function seed(tokenExpiresAt = Date.now() - 1000) {
  seedMcpOAuthStoreForTest(identity.storeKey, {
    authorizationId: "synthetic-authorization",
    clientInformation: { client_id: "synthetic-client", issuer },
    tokens: {
      access_token: "synthetic-old-access",
      refresh_token: "synthetic-old-refresh",
      token_type: "Bearer",
      issuer,
    },
    tokenExpiresAt,
    tokensAuthorizationServerUrl: issuer,
    discoveryState: {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: endpoint,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: { resource: identity.serverUrl, authorization_servers: [issuer] },
    },
  });
}
function tokens() {
  return Response.json({
    access_token: "synthetic-new-access",
    refresh_token: "synthetic-new-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  });
}
beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("mcp-real-refresh-"));
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("real MCP SDK token HTTP and durable owner", () => {
  it("serializes rotating callers and persists the SDK-parsed replacement under the same authorization", async () => {
    seed();
    const entered = createDeferred();
    const release = createDeferred();
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(resolveRequestUrl(url)).toBe(endpoint);
      expect(init?.method).toBe("POST");
      const form = new URLSearchParams(await new Response(init?.body).text());
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("synthetic-old-refresh");
      expect(form.get("client_id")).toBe("synthetic-client");
      expect(form.get("resource")).toBe(identity.serverUrl);
      entered.resolve();
      await release.promise;
      return tokens();
    });
    const first = resolveMcpOAuthAccessToken({ identity, fetchFn });
    const second = resolveMcpOAuthAccessToken({ identity, fetchFn });
    try {
      await awaitGateBeforeSettlement(entered.promise, first, "refresh settled before HTTP");
      expect((await readMcpOAuthStore(identity.storeKey)).refreshClaim).toEqual(expect.any(String));
      release.resolve();
      expect(await Promise.all([first, second])).toEqual([
        "synthetic-new-access",
        "synthetic-new-access",
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const row = await readMcpOAuthStore(identity.storeKey);
      expect(row).toMatchObject({
        authorizationId: "synthetic-authorization",
        tokens: { refresh_token: "synthetic-new-refresh", issuer },
      });
      expect(row.refreshClaim).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("reconciles a committed claim whose write reply was lost before dispatch", async () => {
    seed();
    const mutate = oauthStore.mutateMcpOAuthStore;
    const spy = vi.spyOn(oauthStore, "mutateMcpOAuthStore").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[1].kind === "beginRefresh") {
        spy.mockRestore();
        throw new Error("synthetic claim receipt lost after commit");
      }
      return result;
    });
    const fetchFn = vi.fn<typeof fetch>(async () => tokens());
    try {
      await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow();
      expect(fetchFn).not.toHaveBeenCalled();
      expect((await readMcpOAuthStore(identity.storeKey)).refreshClaim).toBeUndefined();
      await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).resolves.toBe(
        "synthetic-new-access",
      );
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("retains an unchanged refresh token omitted by the real SDK response across reopening", async () => {
    seed();
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(resolveRequestUrl(url)).toBe(endpoint);
      const form = new URLSearchParams(await new Response(init?.body).text());
      expect(form.get("refresh_token")).toBe("synthetic-old-refresh");
      return Response.json({
        access_token: "synthetic-new-access",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).resolves.toBe(
      "synthetic-new-access",
    );
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
      authorizationId: "synthetic-authorization",
      tokens: { access_token: "synthetic-new-access", refresh_token: "synthetic-old-refresh" },
    });
    await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).resolves.toBe(
      "synthetic-new-access",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(["lost-response", "503", "nested-rejection", "invalid-success"])(
    "fences %s without SDK fallback deleting client provenance or replaying a grant",
    async (failure) => {
      seed();
      const fetchFn = vi.fn<typeof fetch>(async (url) => {
        expect(resolveRequestUrl(url)).toBe(endpoint);
        if (failure === "lost-response") {
          throw new TypeError("synthetic consumed response lost");
        }
        if (failure === "503") {
          return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        }
        if (failure === "nested-rejection") {
          return Response.json({
            access_token: "synthetic-access",
            error: { code: "invalid_grant" },
          });
        }
        return Response.json({
          access_token: "synthetic-access",
          refresh_token: 42,
          token_type: "Bearer",
        });
      });
      await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow();
      await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow(/uncertain/);
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow(/uncertain/);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
        refreshClaim: expect.any(String),
        clientInformation: { client_id: "synthetic-client", issuer },
        tokens: { refresh_token: "synthetic-old-refresh" },
      });
    },
  );

  it("fences a rejected locally fresh token after an uncertain refresh across reopening", async () => {
    seed(Date.now() + 3_600_000);
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      expect(resolveRequestUrl(url)).toBe(endpoint);
      throw new TypeError("synthetic consumed response lost");
    });
    await expect(
      resolveMcpOAuthAccessToken({
        identity,
        fetchFn,
        rejectedAccessToken: "synthetic-old-access",
      }),
    ).rejects.toThrow();
    await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow(/uncertain/);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow(/uncertain/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await readMcpOAuthStore(identity.storeKey)).toMatchObject({
      refreshClaim: expect.any(String),
      tokens: { access_token: "synthetic-old-access", refresh_token: "synthetic-old-refresh" },
    });
  });

  it("cancels a stalled token body at the exchange deadline without replaying the grant", async () => {
    seed();
    const deadline = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => (ms === 30_000 ? deadline.signal : nativeTimeout(ms)));
    const reading = createDeferred();
    const cancel = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream(
            {
              pull() {
                reading.resolve();
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const refresh = resolveMcpOAuthAccessToken({ identity, fetchFn });
    const outcome = refresh.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(reading.promise, refresh, "refresh settled before body read");
      deadline.abort(new DOMException("Exchange deadline expired", "TimeoutError"));
      expect(await outcome).toMatchObject({ message: expect.stringContaining("uncertain") });
      expect(cancel).toHaveBeenCalledOnce();
      await expect(resolveMcpOAuthAccessToken({ identity, fetchFn })).rejects.toThrow(/uncertain/);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect((await readMcpOAuthStore(identity.storeKey)).refreshClaim).toEqual(expect.any(String));
    } finally {
      deadline.abort();
      await outcome;
      timeout.mockRestore();
    }
  });

  it("detaches an aborted caller while the admitted HTTP exchange settles for another caller", async () => {
    seed();
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      transportSignal = init?.signal;
      entered.resolve();
      await release.promise;
      return tokens();
    });
    const first = resolveMcpOAuthAccessToken({ identity, fetchFn, signal: controller.signal });
    const outcome = first.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, first, "refresh settled before HTTP");
      controller.abort();
      expect(transportSignal?.aborted).toBe(false);
      expect(await outcome).toMatchObject({ name: "AbortError" });
      const second = resolveMcpOAuthAccessToken({ identity, fetchFn });
      release.resolve();
      await expect(second).resolves.toBe("synthetic-new-access");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect((await readMcpOAuthStore(identity.storeKey)).tokens?.refresh_token).toBe(
        "synthetic-new-refresh",
      );
    } finally {
      release.resolve();
      await outcome;
    }
  });

  it("rejects a caller cancelled while another caller holds the lease", async () => {
    seed();
    const entered = createDeferred();
    const release = createDeferred();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      entered.resolve();
      await release.promise;
      return tokens();
    });
    const holder = resolveMcpOAuthAccessToken({ identity, fetchFn });
    try {
      await awaitGateBeforeSettlement(entered.promise, holder, "refresh settled before HTTP");
      // The waiter first checks for a reusable token without the lease; cancel once it waits.
      const waiting = createDeferred();
      const acquire = leaseAcquisition.acquireOpenClawStateLease;
      const acquisition = vi
        .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
        .mockImplementation((params) => {
          waiting.resolve();
          return acquire(params);
        });
      const controller = new AbortController();
      const waiter = resolveMcpOAuthAccessToken({ identity, fetchFn, signal: controller.signal });
      await waiting.promise;
      acquisition.mockRestore();
      controller.abort();
      // Rejects while the holder still owns the lease.
      await expect(waiter).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      release.resolve();
      await expect(holder).resolves.toBe("synthetic-new-access");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
    }
  });
});
