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
function tokens(rotates = true) {
  return Response.json({
    access_token: "synthetic-new-access",
    ...(rotates ? { refresh_token: "synthetic-new-refresh" } : {}),
    token_type: "Bearer",
    expires_in: 3600,
  });
}
const read = () => readMcpOAuthStore(identity.storeKey);
const refresh = (
  fetchFn: typeof fetch,
  options: { signal?: AbortSignal; rejectedAccessToken?: string } = {},
) => resolveMcpOAuthAccessToken({ identity, fetchFn, ...options });
async function reopen() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
async function expectFenced(fetchFn: typeof fetch) {
  await expect(refresh(fetchFn)).rejects.toThrow(/uncertain/);
  await reopen();
  await expect(refresh(fetchFn)).rejects.toThrow(/uncertain/);
  expect(fetchFn).toHaveBeenCalledTimes(1);
}
function heldRefresh(
  options: Parameters<typeof refresh>[1] = {},
  inspect?: (...args: Parameters<typeof fetch>) => void | Promise<void>,
  rotates = true,
) {
  const entered = createDeferred();
  const release = createDeferred();
  const fetchFn = vi.fn<typeof fetch>(async (...args) => {
    await inspect?.(...args);
    entered.resolve();
    await release.promise;
    return tokens(rotates);
  });
  const first = refresh(fetchFn, options);
  const pending = [first];
  return {
    fetchFn,
    first,
    release: release.resolve,
    entered: () => awaitGateBeforeSettlement(entered.promise, first, "refresh settled before HTTP"),
    next: () => {
      const next = refresh(fetchFn);
      pending.push(next);
      return next;
    },
    [Symbol.asyncDispose]: async () => {
      release.resolve();
      await Promise.allSettled(pending);
    },
  };
}
beforeEach(async () => {
  await reopen();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("mcp-real-refresh-"));
});
afterEach(async () => {
  await reopen();
  vi.unstubAllEnvs();
});

describe("real MCP SDK token HTTP and durable owner", () => {
  it.each([true, false])(
    "serializes callers and persists SDK tokens across reopening (rotates=%s)",
    async (rotates) => {
      seed();
      await using held = heldRefresh(
        {},
        async (url, init) => {
          expect(resolveRequestUrl(url)).toBe(endpoint);
          expect(init?.method).toBe("POST");
          const form = new URLSearchParams(await new Response(init?.body).text());
          expect(Object.fromEntries(form)).toMatchObject({
            grant_type: "refresh_token",
            refresh_token: "synthetic-old-refresh",
            client_id: "synthetic-client",
            resource: identity.serverUrl,
          });
        },
        rotates,
      );
      const { fetchFn, first, entered, release } = held;
      const second = held.next();
      await entered();
      expect((await read()).refreshClaim).toEqual(expect.any(String));
      release();
      expect(await Promise.all([first, second])).toEqual([
        "synthetic-new-access",
        "synthetic-new-access",
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await reopen();
      const row = await read();
      expect(row).toMatchObject({
        authorizationId: "synthetic-authorization",
        tokens: {
          access_token: "synthetic-new-access",
          refresh_token: rotates ? "synthetic-new-refresh" : "synthetic-old-refresh",
          issuer,
        },
      });
      expect(row.refreshClaim).toBeUndefined();
      await expect(refresh(fetchFn)).resolves.toBe("synthetic-new-access");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("reconciles a committed claim whose write reply was lost before dispatch", async () => {
    seed();
    const mutate = oauthStore.mutateMcpOAuthStore;
    using spy = vi.spyOn(oauthStore, "mutateMcpOAuthStore").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[1].kind === "beginRefresh") {
        spy.mockRestore();
        throw new Error("synthetic claim receipt lost after commit");
      }
      return result;
    });
    const fetchFn = vi.fn<typeof fetch>(async () => tokens());
    await expect(refresh(fetchFn)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await read()).refreshClaim).toBeUndefined();
    await expect(refresh(fetchFn)).resolves.toBe("synthetic-new-access");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each(["lost-response", "503", "nested-rejection", "invalid-success", "rejected-fresh"])(
    "fences %s without SDK fallback deleting client provenance or replaying a grant",
    async (failure) => {
      seed(failure === "rejected-fresh" ? Date.now() + 3_600_000 : undefined);
      const fetchFn = vi.fn<typeof fetch>(async (url) => {
        expect(resolveRequestUrl(url)).toBe(endpoint);
        if (failure === "lost-response" || failure === "rejected-fresh") {
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
      await expect(
        refresh(
          fetchFn,
          failure === "rejected-fresh" ? { rejectedAccessToken: "synthetic-old-access" } : {},
        ),
      ).rejects.toThrow();
      await expectFenced(fetchFn);
      expect(await read()).toMatchObject({
        refreshClaim: expect.any(String),
        clientInformation: { client_id: "synthetic-client", issuer },
        tokens: { access_token: "synthetic-old-access", refresh_token: "synthetic-old-refresh" },
      });
    },
  );

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
    const pending = refresh(fetchFn);
    const outcome = pending.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(reading.promise, pending, "refresh settled before body read");
      deadline.abort(new DOMException("Exchange deadline expired", "TimeoutError"));
      expect(await outcome).toMatchObject({ message: expect.stringContaining("uncertain") });
      expect(cancel).toHaveBeenCalledOnce();
      await expect(refresh(fetchFn)).rejects.toThrow(/uncertain/);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect((await read()).refreshClaim).toEqual(expect.any(String));
    } finally {
      deadline.abort();
      await outcome;
      timeout.mockRestore();
    }
  });

  it("detaches an aborted caller while the admitted HTTP exchange settles for another caller", async () => {
    seed();
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    await using held = heldRefresh({ signal: controller.signal }, (_url, init) => {
      transportSignal = init?.signal;
    });
    const { fetchFn, first, entered, release } = held;
    const outcome = first.catch((error: unknown) => error);
    await entered();
    controller.abort();
    expect(transportSignal?.aborted).toBe(false);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    const second = held.next();
    release();
    await expect(second).resolves.toBe("synthetic-new-access");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await read()).tokens?.refresh_token).toBe("synthetic-new-refresh");
  });

  it("rejects a caller cancelled while another caller holds the lease", async () => {
    seed();
    await using held = heldRefresh();
    const { fetchFn, first: holder, entered, release } = held;
    await entered();
    // The waiter first checks for a reusable token without the lease; cancel once it waits.
    const waiting = createDeferred();
    const acquire = leaseAcquisition.acquireOpenClawStateLease;
    using acquisition = vi
      .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
      .mockImplementation((params) => {
        waiting.resolve();
        return acquire(params);
      });
    const controller = new AbortController();
    const waiter = refresh(fetchFn, { signal: controller.signal });
    await waiting.promise;
    acquisition.mockRestore();
    controller.abort();
    // Rejects while the holder still owns the lease.
    await expect(waiter).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    release();
    await expect(holder).resolves.toBe("synthetic-new-access");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
