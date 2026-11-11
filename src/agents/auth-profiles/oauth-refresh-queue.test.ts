/** Tests durable ownership after an OAuth refresh failure. */
import { describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOAuthRefreshError } from "../../shared/oauth-refresh-outcome.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import { expectTerminal, useOAuthCoordinationFixture } from "./oauth-coordination.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { mockOAuthProviderOperations } from "./oauth-native-provider.test-support.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

// Real file locks and queue admissions: the cohort case observes native admissions.
const fx = useOAuthCoordinationFixture();
const expiredCredential = (prefix: string, overrides: Partial<OAuthCredential> = {}) =>
  createOAuthRefreshCredential({
    provider: "xai",
    access: `synthetic-${prefix}-access`,
    refresh: `synthetic-${prefix}-refresh`,
    expires: Date.now() - 60_000,
    ...overrides,
  });
function resolver(profileId: string, credential: OAuthCredential) {
  const manager = createOAuthManager();
  return (agentDir: string) =>
    manager.resolveOAuthAccess({
      store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
      profileId,
      credential,
      agentDir,
    });
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

describe("OAuth refresh failure ownership", () => {
  it("terminally fences an unknown failure for concurrent and later callers", async () => {
    const profileId = "xai:terminal";
    const original = expiredCredential("terminal");
    const message = "unclassified upstream failure";
    const refreshCredential = vi.fn().mockRejectedValue(new Error(message));
    mockOAuthProviderOperations({ refreshCredential });
    fx.settle(() => {
      vi.restoreAllMocks();
    });
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, fx.mainDir);
    const resolve = resolver(profileId, original);
    const results = await Promise.all([
      resolve(fx.mainDir).catch((e: unknown) => e),
      resolve(fx.mainDir).catch((e: unknown) => e),
    ]);
    expect(results.filter((result) => result instanceof Error)).toEqual([
      expect.objectContaining({ message: expect.stringContaining(message) }),
    ]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expectTerminal(loadPersistedAuthProfileStore(fx.mainDir)?.profiles[profileId]);
    await expect(resolve(fx.mainDir)).resolves.toBeNull();
    expect(refreshCredential).toHaveBeenCalledOnce();
  });

  it("shares safe failures only with queued callers for the same path and generation", async () => {
    const profileId = "xai:cohort";
    const credential = expiredCredential("cohort", { expires: 1 });
    const firstDir = await fx.agentDirectory("first");
    const secondDir = await fx.agentDirectory("second");
    const nextGeneration = { ...credential, access: "new-generation", refresh: "new-refresh" };
    const refreshed = {
      ...nextGeneration,
      access: "rotated-access",
      expires: Date.now() + 600_000,
    };
    for (const dir of [firstDir, secondDir]) {
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, dir);
    }
    const release = createDeferredCore();
    const secondEntered = createDeferredCore();
    const releaseSecond = createDeferredCore();
    const admissions = [
      createDeferredCore(),
      createDeferredCore(),
      createDeferredCore(),
      createDeferredCore(),
    ] as const;
    // Observe actual native admissions without replacing the queue or file locks.
    // Shared fixture setup resets module identity, so use the manager's current module.
    const { KeyedAsyncQueue } = await import("../../plugin-sdk/keyed-async-queue.js");
    // oxlint-disable-next-line typescript/unbound-method -- Called with the original queue receiver.
    const enqueue = KeyedAsyncQueue.prototype.enqueue;
    let admissionIndex = 0;
    vi.spyOn(KeyedAsyncQueue.prototype, "enqueue").mockImplementation(function (
      this: InstanceType<typeof KeyedAsyncQueue>,
      key,
      task,
      hooks,
    ) {
      return enqueue.call(this, key, task, {
        ...hooks,
        onEnqueue() {
          hooks?.onEnqueue?.();
          admissions[admissionIndex++]?.resolve();
        },
      });
    });
    const failure = () =>
      createOAuthRefreshError("synthetic provider proves grant unchanged", {
        version: 1,
        phase: "token-response",
        outcome: "unchanged",
        recovery: { kind: "later", evidence: "documented-reusable-grant" },
      });
    const refreshCredential = vi
      .fn<(input: OAuthCredential) => Promise<OAuthCredential>>()
      .mockImplementationOnce(async () => {
        await release.promise;
        throw failure();
      })
      .mockImplementationOnce(async () => {
        secondEntered.resolve();
        await releaseSecond.promise;
        throw failure();
      })
      .mockRejectedValueOnce(failure());
    mockOAuthProviderOperations({ refreshCredential });
    const resolve = resolver(profileId, credential);
    const requests: Promise<unknown>[] = [];
    fx.settle(async () => {
      release.resolve();
      releaseSecond.resolve();
      await Promise.allSettled(requests);
      vi.restoreAllMocks();
    });
    // The second path has identical bytes. The final first-path waiter will see
    // a newer expired generation, installed while the second provider call is held.
    const start = (dir: string) => {
      const request = resolve(dir).catch((error: unknown) => error);
      requests.push(request);
      return request;
    };
    const first = start(firstDir);
    await admissions[0].promise;
    const same = start(firstDir);
    await admissions[1].promise;
    const other = start(secondDir);
    await admissions[2].promise;
    const next = start(firstDir);
    await admissions[3].promise;
    release.resolve();
    await Promise.race([
      secondEntered.promise,
      other.then(() => {
        throw new Error("different path did not reach the provider");
      }),
    ]);
    expect(await first).toMatchObject({ retryable: true });
    expect(await same).toMatchObject({ retryable: true });
    expect(refreshCredential).toHaveBeenCalledTimes(2);
    // The active second-path claim also fences its matching peer; a newer login must survive its rollback.
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: nextGeneration } }, firstDir);
    releaseSecond.resolve();
    expect(await other).toMatchObject({ retryable: true });
    expect(await next).toMatchObject({ retryable: true });
    expect(refreshCredential.mock.calls.map(([input]) => input)).toEqual([
      credential,
      credential,
      nextGeneration,
    ]);
    expect(loadPersistedAuthProfileStore(firstDir)?.profiles[profileId]).toEqual(nextGeneration);
    expect(loadPersistedAuthProfileStore(secondDir)?.profiles[profileId]).toEqual(credential);
    refreshCredential.mockResolvedValueOnce(refreshed);
    await expect(resolve(firstDir)).resolves.toMatchObject({ apiKey: refreshed.access });
    expect(refreshCredential).toHaveBeenCalledTimes(4);
  });

  it("cancels auth waiters while the canonical refresh owner durably settles for another caller", async () => {
    const profileId = "xai:default";
    const credential = expiredCredential("cancelled", {
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      accountId: "synthetic-account",
    });
    const refreshed = {
      ...credential,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 600_000,
    };
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, fx.mainDir);
    const started = createDeferredCore();
    const release = createDeferredCore<OAuthCredential>();
    const settled = createDeferredCore();
    const refreshCredential = vi.fn(async () => {
      started.resolve();
      return await release.promise;
    });
    mockOAuthProviderOperations({
      buildApiKey: async (_provider, value) => {
        settled.resolve();
        return value.access;
      },
      refreshCredential,
    });
    const manager = createOAuthManager();
    const params = {
      store: ensureAuthProfileStore(fx.mainDir),
      profileId,
      credential,
      agentDir: fx.mainDir,
    };
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const activeReason = new Error("active lookup cancelled");
    const queuedReason = new Error("queued lookup cancelled");
    const scope = new AsyncWorkScope();
    const active = scope.run(() =>
      manager.resolveOAuthAccess({ ...params, signal: activeController.signal }),
    );
    const activeRejected = expect(active).rejects.toBe(activeReason);
    const requests: Promise<unknown>[] = [active, activeRejected];
    const cleanup = async () => {
      activeController.abort(activeReason);
      queuedController.abort(queuedReason);
      release.resolve(refreshed);
      await Promise.allSettled([...requests, scope.drain()]);
    };
    fx.settle(async () => {
      await cleanup();
      vi.restoreAllMocks();
    });
    try {
      await started.promise;
      const queued = scope.run(() =>
        manager.resolveOAuthAccess({ ...params, signal: queuedController.signal }),
      );
      const queuedRejected = expect(queued).rejects.toBe(queuedReason);
      requests.push(queued, queuedRejected);
      queuedController.abort(queuedReason);
      await queuedRejected;
      activeController.abort(activeReason);
      await activeRejected;
      const pending = ensureAuthProfileStoreWithoutExternalProfiles(fx.mainDir).profiles[profileId];
      expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
      let drained = false;
      const draining = scope.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve(refreshed);
      await draining;
      await settled.promise;
      const continuing = manager.resolveOAuthAccess(params);
      requests.push(continuing);
      await expect(continuing).resolves.toMatchObject({ apiKey: "rotated-access" });
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(fx.mainDir).profiles[profileId],
      ).toMatchObject(refreshed);
      expect(refreshCredential).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });
});
