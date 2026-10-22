/** Tests durable ownership after an OAuth refresh failure. */
import { describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOAuthRefreshError,
  type OAuthRefreshOutcome,
} from "../../shared/oauth-refresh-outcome.js";
import { useOAuthCoordinationFixture } from "./oauth-coordination.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { mockOAuthProviderOperations } from "./oauth-native-provider.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { createExpiredOauthStore } from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

// Real file locks and queue admissions: the cohort case observes native admissions.
const fx = useOAuthCoordinationFixture();

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

describe("OAuth refresh failure ownership", () => {
  it.each(["xAI OAuth token response is missing access_token", "unclassified upstream failure"])(
    "keeps provider validation and unknown failures terminal: %s",
    async (message) => {
      const profileId = "xai:terminal";
      const original: OAuthCredential = {
        type: "oauth",
        provider: "xai",
        access: "synthetic-terminal-access",
        refresh: "synthetic-terminal-refresh",
        expires: Date.now() - 60_000,
      };
      const refreshCredential = vi.fn().mockRejectedValue(new Error(message));
      mockOAuthProviderOperations({ refreshCredential });
      fx.settle(() => {
        vi.restoreAllMocks();
      });
      const agentDir = fx.mainDir;
      const manager = createOAuthManager();
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, agentDir);
      const resolve = () =>
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: original,
          agentDir,
        });
      await expect(resolve()).rejects.toThrow(message);
      const persisted = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
      expect(isOAuthRefreshFence(persisted?.type === "oauth" ? persisted : undefined)).toBe(true);
      expect(isPendingOAuthRefreshFence(persisted?.type === "oauth" ? persisted : undefined)).toBe(
        false,
      );
      await expect(resolve()).resolves.toBeNull();
      expect(refreshCredential).toHaveBeenCalledTimes(1);
    },
  );

  it("fences the failed generation instead of retrying it", async () => {
    const profileId = "openai:default";
    const provider = "openai";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), fx.mainDir);

    let callCount = 0;
    fx.refresh.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("simulated upstream failure");
      }
      // A failed owner leaves its generation fenced. No peer may replay it.
      return {
        type: "oauth",
        provider,
        access: "second-try-access",
        refresh: "second-try-refresh",
        expires: Date.now() + 60_000,
      } as never;
    });

    const results = await Promise.all([
      fx.resolve(fx.mainDir).catch((e: unknown) => e),
      fx.resolve(fx.mainDir).catch((e: unknown) => e),
    ]);

    expect(results.filter((result) => result instanceof Error)).toHaveLength(1);
    expect(callCount).toBe(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it.each<OAuthRefreshOutcome>([
    {
      version: 1,
      phase: "before-dispatch",
      outcome: "not-attempted",
      recovery: { kind: "later", evidence: "dispatch-not-started" },
    },
    {
      version: 1,
      phase: "token-response",
      outcome: "unchanged",
      recovery: { kind: "later", evidence: "documented-reusable-grant" },
    },
    {
      version: 1,
      phase: "token-response",
      outcome: "unchanged",
      status: 503,
      recovery: { kind: "later", evidence: "owner-accepted-provider-retry" },
    },
  ])(
    "shares a positively safe $phase failure only with queued callers for the same path and generation",
    async (facts) => {
      const profileId = "xai:cohort";
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "xai",
        access: "synthetic-cohort-access",
        refresh: "synthetic-cohort-refresh",
        expires: 1,
      };
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
        createOAuthRefreshError("synthetic provider proves grant unchanged", facts);
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
      const manager = createOAuthManager();
      const resolve = (dir: string) =>
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(dir),
          profileId,
          credential,
          agentDir: dir,
        });
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
    },
  );

  it("cancels auth waiters while the canonical refresh owner durably settles for another caller", async () => {
    const profileId = "xai:default";
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "xai",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() - 60_000,
      accountId: "synthetic-account",
    };
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
