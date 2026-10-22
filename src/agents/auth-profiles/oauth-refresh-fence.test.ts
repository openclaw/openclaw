import "./external-auth.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createOAuthRefreshCredential as createCredential,
  oauthRefreshReplacementCases,
  oauthRefreshFailureFallbackCases,
} from "./credential-fixtures.test-support.js";
import { inlineAuthProfileCredentialSchema } from "./credential-schema.js";
import * as externalCliSync from "./external-cli-sync.js";
import { createOAuthManager } from "./oauth-manager.js";
import { mockOAuthProviderOperations } from "./oauth-native-provider.test-support.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { OAuthManagerRefreshError } from "./oauth-refresh-failure.js";
import { refreshSerializedOAuthCredential } from "./oauth-refresh-fence.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import * as authProfileStoreRuntime from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { testing: externalAuthTesting } = await import("./external-auth.test-support.js");

const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
  authProfileStoreRuntime;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let settleManagerWork: (() => Promise<void>) | undefined;

type RefreshResult = { apiKey: string; credential: OAuthCredential };
type Refresh = (credential: OAuthCredential) => Promise<RefreshResult | null>;

function serializedStore(
  credential: OAuthCredential,
  timeoutMs = 1_000,
  beforeWrite: (next: string) => void = () => {},
) {
  const profileId = "openai:default";
  let persisted = JSON.stringify({ [profileId]: credential });
  let lockDepth = 0;
  const backend = {
    withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
      expect(lockDepth).toBe(0);
      lockDepth++;
      try {
        const update = fn(persisted);
        if (update.next !== undefined) {
          beforeWrite(update.next);
          persisted = update.next;
        }
        return update.result;
      } finally {
        lockDepth--;
      }
    },
  };
  return {
    backend,
    get lockDepth() {
      return lockDepth;
    },
    read: () => JSON.parse(persisted)[profileId] as OAuthCredential,
    write: (value: OAuthCredential) => {
      persisted = JSON.stringify({ [profileId]: value });
    },
    run: (refresh: Refresh) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized refresh",
        timeoutMs,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, value) => ({ ...data, [profileId]: value }),
        canRefresh: async () => true,
        refresh,
        resolve: async (value) => ({ apiKey: value.access, credential: value }),
        commit: () => {},
      }),
  };
}

async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => await run(tempRoot));
}

function saveCredential(profileId: string, credential: OAuthCredential, agentDir?: string) {
  saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
    filterExternalAuthProfiles: false,
  });
}

afterEach(async () => {
  await settleManagerWork?.();
  settleManagerWork = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
});

describe("OAuth refresh generation fence", () => {
  it("keeps serialized provider I/O outside locks and settles after observer timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const expired = createCredential({
      access: "serialized-access",
      refresh: "serialized-refresh",
      expires: 1,
      accountId: "acct-123",
    });
    const storage = serializedStore(expired, 100);
    const run = storage.run;
    const started = createDeferredCore();
    const release = createDeferredCore<{ apiKey: string; credential: OAuthCredential }>();
    const refresh = vi.fn(async () => {
      expect(storage.lockDepth).toBe(0);
      started.resolve();
      return await release.promise;
    });

    const work = new AsyncWorkScope();
    const first = work.run(() => run(refresh));
    await started.promise;
    expect(storage.read().access).toMatch(
      /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
    );
    const firstTimedOut = expect(first).rejects.toThrow("exceeded hard timeout (100ms)");
    await vi.advanceTimersByTimeAsync(100);
    await firstTimedOut;
    const drained = vi.fn();
    const drain = work.drain().then(drained);
    await vi.advanceTimersByTimeAsync(0);
    const drainedBeforeSettlement = drained.mock.calls.length;
    const peerRefresh = vi.fn(async () => null);
    const peer = run(peerRefresh);

    release.resolve({
      apiKey: "serialized-rotated-access",
      credential: createCredential({
        access: "serialized-rotated-access",
        refresh: "serialized-rotated-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      }),
    });
    await drain;
    // A peer may have read the fence before rotation; drive its poll, not microtask ordering.
    await vi.advanceTimersByTimeAsync(25);
    await expect(peer).resolves.toMatchObject({ apiKey: "serialized-rotated-access" });
    expect(drainedBeforeSettlement).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(peerRefresh).not.toHaveBeenCalled();
    expect(storage.read()).toMatchObject({
      access: "serialized-rotated-access",
      refresh: "serialized-rotated-refresh",
    });
  });

  it("rejects a different-account replacement for serialized owner and observer settlement", async () => {
    const expired = createCredential({
      access: "account-a-access",
      refresh: "account-a-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    const storage = serializedStore(expired);
    const run = storage.run;
    const started = createDeferredCore();
    const release = createDeferredCore<{ apiKey: string; credential: OAuthCredential }>();
    const refresh = vi.fn(() => {
      started.resolve();
      return release.promise;
    });

    const owner = run(refresh);
    await started.promise;
    const peerRefresh = vi.fn(async () => null);
    const observer = run(peerRefresh);
    storage.write(
      createCredential({
        access: "account-b-access",
        refresh: "account-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      }),
    );

    await expect(observer).resolves.toBeNull();
    release.resolve({
      apiKey: "rotated-a-access",
      credential: createCredential({
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-a",
      }),
    });
    await expect(owner).rejects.toThrow("owner changed");
    expect(refresh).toHaveBeenCalledOnce();
    expect(peerRefresh).not.toHaveBeenCalled();
    expect(storage.read()).toMatchObject({
      access: "account-b-access",
      refresh: "account-b-refresh",
      accountId: "acct-b",
    });
  });

  it("terminally fences invalid serialized provider outcomes", async () => {
    const expired = createCredential({
      access: "account-a-access",
      refresh: "account-a-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    const storage = serializedStore(expired);
    const run = storage.run;

    await expect(
      run(async () => ({
        apiKey: "account-b-access",
        credential: createCredential({
          access: "account-b-access",
          refresh: "account-b-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-b",
        }),
      })),
    ).rejects.toThrow("different OAuth account");

    let stored = storage.read();
    expect(stored).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct-a",
      expires: 1,
    });
    expect(stored.access).toContain(":failed:access:");
    expect(JSON.stringify(stored)).not.toContain("account-b-access");

    for (const providerRejection of [{ reason: "invalid_grant", status: 401 }, undefined]) {
      storage.write(expired);
      // oxlint-disable-next-line prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
      const failure = await run(() => Promise.reject(providerRejection)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: "OAuth refresh failed", cause: providerRejection });
      if (providerRejection) {
        expect(failure).toMatchObject(providerRejection);
      }
      stored = storage.read();
      expect(isPendingOAuthRefreshFence(stored)).toBe(false);
      expect(stored.access).toContain(":failed:access:");
    }
  });

  it.each([{ outcome: "throw" as const }, { outcome: "null" as const }])(
    "surfaces one failed serialized terminal write after a $outcome refresh",
    async ({ outcome }) => {
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "acct-123",
      });
      let terminalAttempts = 0;
      const terminalError = new Error("failed to persist serialized terminal fence");
      const storage = serializedStore(expired, 1_000, (next) => {
        if (next.includes(":failed:access:")) {
          terminalAttempts++;
          throw terminalError;
        }
      });
      const initiatingError = new Error("provider refresh failed");
      const run = storage.run(async () => {
        if (outcome === "throw") {
          throw initiatingError;
        }
        return null;
      });

      if (outcome === "throw") {
        await expect(run).rejects.toSatisfy((caught: unknown) => {
          expect(caught).toBeInstanceOf(AggregateError);
          const aggregate = caught as AggregateError;
          expect(aggregate.errors).toEqual([initiatingError, terminalError]);
          expect(aggregate.cause).toBe(initiatingError);
          return true;
        });
      } else {
        await expect(run).rejects.toBe(terminalError);
      }
      expect(terminalAttempts).toBe(1);
      expect(storage.lockDepth).toBe(0);
      expect(storage.backend.withLock(() => ({ result: "reacquired" }))).toBe("reacquired");
    },
  );

  it("surfaces one failed manager terminal write after a null refresh", async () => {
    await withOAuthTempRoot("oauth-manager-null-terminal-failure-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "acct-123",
      });
      saveCredential(profileId, expired, agentDir);
      const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
      let terminalAttempts = 0;
      vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
        async (params) => {
          const current =
            ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
          if (current?.type === "oauth" && isPendingOAuthRefreshFence(current)) {
            terminalAttempts += 1;
            return null;
          }
          return await originalUpdate(params);
        },
      );
      mockOAuthProviderOperations({});
      const manager = createOAuthManager();

      let caught: unknown;
      try {
        await manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OAuthManagerRefreshError);
      const refreshError = caught as OAuthManagerRefreshError;
      expect(refreshError.message).toContain("terminal OAuth refresh fence");
      expect(terminalAttempts).toBe(1);
      await expect(
        withOAuthProfileLock({ provider: "openai", profileId }, async () => "reacquired"),
      ).resolves.toBe("reacquired");
    });
  });

  it.each(oauthRefreshReplacementCases())("settles owner and observer for $kind", async (row) => {
    const { identity, replacementIdentity, sameIdentity, coldObserver } = row;
    await withOAuthTempRoot("openclaw-oauth-account-replacement-", async () => {
      const profileId = "openai:default";
      const original = createCredential({
        access: "account-a-access",
        refresh: "account-a-refresh",
        expires: 1,
        ...identity,
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, undefined);

      const refreshFinished = createDeferredCore();
      const refreshStarted = createDeferredCore();
      const refreshCredential = vi.fn(async () => {
        refreshStarted.resolve();
        await refreshFinished.promise;
        return createCredential({
          access: "rotated-a-access",
          refresh: "rotated-a-refresh",
          expires: Date.now() + 600_000,
          ...identity,
        });
      });
      mockOAuthProviderOperations({ refreshCredential });
      const createManager = () => createOAuthManager();
      const work = new AsyncWorkScope();
      settleManagerWork = async () => {
        refreshFinished.resolve();
        await work.drain();
      };
      let watchObserverReads = false;
      const observerReadFence = createDeferredCore();
      const originalLoad = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync;
      const loadSpy = vi
        .spyOn(authProfileStoreRuntime, "loadAuthProfileStoreWithoutExternalProfilesAsync")
        .mockImplementation(async (...args: Parameters<typeof originalLoad>) => {
          const store = await originalLoad(...args);
          const credential = store.profiles[profileId];
          if (
            watchObserverReads &&
            credential?.type === "oauth" &&
            isPendingOAuthRefreshFence(credential)
          ) {
            observerReadFence.resolve();
          }
          return store;
        });

      const owner = work.track(() =>
        createManager().resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(undefined),
          profileId,
          credential: original,
        }),
      );
      await refreshStarted.promise;
      const observerEntered = createDeferredCore();
      watchObserverReads = true;
      const observerStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined);
      const observerCredential = coldObserver ? observerStore.profiles[profileId] : original;
      if (observerCredential?.type !== "oauth") {
        throw new Error("Expected observer OAuth credential");
      }
      if (coldObserver) {
        expect(isPendingOAuthRefreshFence(observerCredential)).toBe(true);
        expect(observerCredential.idToken).toBeUndefined();
      }
      vi.spyOn(externalCliSync, "readExternalCliBootstrapCredential").mockImplementation(() => {
        observerEntered.resolve();
        return null;
      });
      const observer = work.track(() =>
        createManager().resolveOAuthAccess({
          store: observerStore,
          profileId,
          credential: observerCredential,
        }),
      );
      await observerEntered.promise;
      await observerReadFence.promise;
      watchObserverReads = false;
      const relogin = persistAuthProfileBatch({
        profiles: [
          {
            profileId,
            credential: createCredential({
              access: "account-b-access",
              refresh: "account-b-refresh",
              expires: Date.now() + 600_000,
              ...replacementIdentity,
            }),
          },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      await relogin;

      if (sameIdentity) {
        await expect(observer).resolves.toMatchObject({ apiKey: "account-b-access" });
      } else {
        await expect(observer).resolves.toBeNull();
      }
      refreshFinished.resolve();
      if (sameIdentity) {
        await expect(owner).resolves.toMatchObject({ apiKey: "account-b-access" });
      } else {
        await expect(owner).rejects.toThrow("OAuth token refresh failed");
      }
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(loadPersistedAuthProfileStore(undefined)?.profiles[profileId]).toMatchObject({
        access: "account-b-access",
        refresh: "account-b-refresh",
        ...replacementIdentity,
      });
      loadSpy.mockRestore();
    });
  });

  it("persists before provider I/O and prevents replay", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-fence-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "claimed-access",
        refresh: "claimed-refresh",
        idToken: "claimed-id-token",
        oauthRef: {
          source: "openclaw-credentials",
          provider: "openai-codex",
          id: "0123456789abcdef0123456789abcdef",
        },
        expires: 1,
        accountId: "acct-123",
        email: "user@example.test",
        displayName: "Example User",
        chatgptPlanType: "plus",
      });
      saveCredential(profileId, expired, agentDir);
      const refreshed = createCredential({
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      });
      const work = new AsyncWorkScope();
      const refreshFinished = createDeferredCore<OAuthCredential>();
      settleManagerWork = async () => {
        refreshFinished.resolve(refreshed);
        await work.drain();
      };
      const started = createDeferredCore();
      const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
        expect(credential).toEqual(expired);
        started.resolve();
        return await refreshFinished.promise;
      });
      mockOAuthProviderOperations({ refreshCredential });
      const manager = createOAuthManager();

      const first = work.track(() =>
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        }),
      );
      await started.promise;

      const fenced = ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
      expect(fenced).toMatchObject({
        type: "oauth",
        provider: "openai",
        expires: 1,
        accountId: "acct-123",
        email: "user@example.test",
        displayName: "Example User",
        chatgptPlanType: "plus",
      });
      if (fenced?.type !== "oauth") {
        throw new Error("expected fenced OAuth credential");
      }
      expect(fenced.access).toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
      );
      expect(fenced.refresh).toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:refresh:[a-f0-9]{64}$/,
      );
      expect(fenced.idToken).toBeUndefined();
      expect(fenced.oauthRef).toBeUndefined();
      for (const secret of ["claimed-access", "claimed-refresh", "claimed-id-token"]) {
        expect(JSON.stringify(fenced)).not.toContain(secret);
      }
      expect(inlineAuthProfileCredentialSchema.parse(fenced)).toEqual(fenced);

      const restartedManager = createOAuthManager();
      const restarted = work.track(() =>
        restartedManager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        }),
      );
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      refreshFinished.resolve(refreshed);
      await expect(first).resolves.toMatchObject({ apiKey: "rotated-access" });
      await expect(restarted).resolves.toMatchObject({ apiKey: "rotated-access" });
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
      ).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      });
    });
  });

  it("preserves the original credential when no refresh owner exists", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-unowned-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "unowned:default";
      const expired = createCredential({
        provider: "unowned",
        access: "unowned-access",
        refresh: "unowned-refresh",
        expires: 1,
      });
      saveCredential(profileId, expired, agentDir);
      const refreshCredential = vi.fn(async () => null);
      mockOAuthProviderOperations({
        canRefreshCredential: async () => false,
        refreshCredential,
      });
      const manager = createOAuthManager();

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
        expired,
      );
    });
  });

  it("rejects a late settlement after an identity-less generation is restored and reclaimed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const firstCredential = createCredential({
      access: "first-access",
      refresh: "stable-refresh",
      expires: 1,
    });
    const storage = serializedStore(firstCredential, 10);
    const run = storage.run;
    let settleFirst:
      | ((result: { apiKey: string; credential: OAuthCredential }) => void)
      | undefined;
    const first = run(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    const firstTimedOut = expect(first).rejects.toThrow("exceeded hard timeout (10ms)");
    await vi.advanceTimersByTimeAsync(10);
    await firstTimedOut;

    storage.write(firstCredential);
    await expect(
      run(async () => ({
        apiKey: "second-rotated-access",
        credential: createCredential({
          access: "second-rotated-access",
          refresh: "second-rotated-refresh",
          expires: Date.now() + 600_000,
        }),
      })),
    ).resolves.toMatchObject({ apiKey: "second-rotated-access" });

    settleFirst?.({
      apiKey: "late-first-access",
      credential: createCredential({
        access: "late-first-access",
        refresh: "late-first-refresh",
        expires: Date.now() + 600_000,
      }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(storage.read()).toMatchObject({
      access: "second-rotated-access",
      refresh: "second-rotated-refresh",
    });
  });

  it("does not replace a terminal fence from an unordered external generation", async () => {
    await withOAuthTempRoot("oauth-manager-fence-recovery-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:default";
      const fence = createFailedOAuthRefreshFence(
        createOAuthRefreshFence({
          profileId,
          credential: createCredential({
            access: "claimed-access",
            refresh: "claimed-refresh",
            expires: 1,
            accountId: "acct-123",
          }),
        }),
      );
      saveCredential(profileId, fence, agentDir);
      const recovered = createCredential({
        access: "recovered-access",
        refresh: "recovered-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      });
      vi.spyOn(externalCliSync, "readExternalCliBootstrapCredential").mockReturnValue(recovered);
      const refreshCredential = vi.fn(async () => null);
      mockOAuthProviderOperations({ refreshCredential });
      const manager = createOAuthManager();

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: fence,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
        fence,
      );
    });
  });

  it.each(
    oauthRefreshFailureFallbackCases().filter(({ buildError }) => typeof buildError === "string"),
  )("$name after a forced refresh failure", async ({ candidate, buildError }) => {
    await withOAuthTempRoot("oauth-manager-force-fallback-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const supplied = createCredential({
        access: "failed-access",
        refresh: "failed-refresh",
        accountId: "acct-123",
      });
      saveCredential(profileId, supplied, agentDir);
      mockOAuthProviderOperations({
        buildApiKey: async (_provider, credential) => {
          if (credential.access === candidate.access) {
            throw new Error(buildError);
          }
          return credential.access;
        },
        refreshCredential: async () => {
          // The provider result is fresh at publication, not at table collection.
          saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                [profileId]: createCredential({ ...candidate, expires: Date.now() + 600_000 }),
              },
            },
            agentDir,
            { filterExternalAuthProfiles: false },
          );
          throw new Error("forced refresh failed");
        },
      });
      const manager = createOAuthManager();
      const resolution = manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential: supplied,
        agentDir,
        forceRefresh: true,
      });

      await expect(resolution).rejects.toSatisfy((caught: unknown) => {
        expect(caught).toBeInstanceOf(OAuthManagerRefreshError);
        const error = caught as OAuthManagerRefreshError;
        expect(error.message).toContain("forced refresh failed");
        expect(error.cause).toBeInstanceOf(AggregateError);
        expect((error.cause as AggregateError).errors.map(formatErrorMessage)).toEqual([
          "forced refresh failed",
          buildError,
        ]);
        return true;
      });
    });
  });

  it.each([
    { name: "access changed", change: "access", expectedCalls: 0 },
    { name: "only expiry changed", change: "expires", expectedCalls: 1 },
  ] as const)(
    "checks authoritative $name before forced provider I/O",
    async ({ change, expectedCalls }) => {
      await withOAuthTempRoot("oauth-manager-force-authoritative-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const supplied = createCredential({
          access: "supplied-access",
          refresh: "supplied-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-123",
        });
        const live = createCredential({
          ...supplied,
          ...(change === "access" ? { access: "live-access" } : {}),
          ...(change === "expires" ? { expires: supplied.expires + 600_000 } : {}),
        });
        const staleStore = { version: 1 as const, profiles: { [profileId]: supplied } };
        saveCredential(profileId, live, agentDir);
        const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
          expect(credential).toEqual(live);
          return createCredential({
            ...credential,
            access: "provider-rotated-access",
            refresh: "provider-rotated-refresh",
            expires: Date.now() + 600_000,
          });
        });
        mockOAuthProviderOperations({
          refreshCredential,
        });
        const manager = createOAuthManager();

        await expect(
          manager.resolveOAuthAccess({
            store: staleStore,
            profileId,
            credential: supplied,
            agentDir,
            forceRefresh: true,
          }),
        ).resolves.toMatchObject({
          apiKey: expectedCalls === 0 ? "live-access" : "provider-rotated-access",
        });
        expect(refreshCredential).toHaveBeenCalledTimes(expectedCalls);
      });
    },
  );
});
