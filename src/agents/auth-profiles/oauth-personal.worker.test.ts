import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it as baseIt, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerRequest,
} from "../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOAuthRefreshError } from "../../shared/oauth-refresh-outcome.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { withPersonalCredentialPublication } from "../../state/user-model-account-authority.js";
import {
  clearUserProfileAuthLinkAsync,
  connectUserModelAccountAsync,
  prepareUserModelAccountAuthority,
} from "../../state/user-model-account-operations.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  readSelectedUserModelAccount,
  setUserProfileAuthLink,
  updateUserModelAuthProfile,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../../state/user-profile-events.js";
import { mergeCanonicalUserProfiles } from "../../state/user-profile-writes.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./credential-observation.js";
import { createOAuthManager } from "./oauth-manager.js";
import {
  mockOAuthProviderOperations,
  type NativeOAuthProviderFixture,
} from "./oauth-native-provider.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import { writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { inspectAuthProfileJsonCell } from "./sqlite-json.js";
import type { OAuthCredential, ProfileUsageStats, UserModelAuthProfile } from "./types.js";
import { reconcileWhamBlock, type WhamCooldownProbeResult } from "./usage-reduction.js";

function nonattemptedRefresh() {
  return createOAuthRefreshError("Synthetic provider dispatch did not start", {
    version: 1,
    phase: "before-dispatch",
    outcome: "not-attempted",
    recovery: { kind: "later", evidence: "dispatch-not-started" },
  });
}

const authorityUnavailable = "Personal model account authority is unavailable";
function expectUnavailable(read: () => unknown) {
  expect(read).toThrow(authorityUnavailable);
}

function managerWith(overrides: NativeOAuthProviderFixture) {
  mockOAuthProviderOperations(overrides);
  return createOAuthManager();
}

function resolve(
  manager: ReturnType<typeof createOAuthManager>,
  profileId: string,
  credential: OAuthCredential,
  options: Partial<Parameters<typeof manager.resolveOAuthAccess>[0]> = {},
) {
  return manager.resolveOAuthAccess({
    profileId,
    credential,
    store: { version: 1, profiles: { [profileId]: credential } },
    ...options,
  });
}

async function withoutDatabase<T>(run: () => T): Promise<Awaited<T>> {
  const sql = observeMainThreadSql();
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  try {
    return await run();
  } finally {
    try {
      sql.expectIdle();
      expect(requests).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      requests.mockRestore();
    }
  }
}

function fixture() {
  const owner = ensureProfileForEmail("personal-race@example.test");
  const credential: OAuthCredential = {
    type: "oauth",
    provider: "synthetic",
    access: "synthetic-old-access",
    refresh: "synthetic-old-refresh",
    expires: 1,
    accountId: "synthetic-account",
  };
  const { authProfileId: profileId } = connectUserModelAccount({
    ownerProfileId: owner.id,
    credential,
    assertCurrent() {},
  });
  const replacement: OAuthCredential = {
    ...credential,
    expires: Date.now() + 600_000,
    access: "synthetic-replaced",
    refresh: "synthetic-replacement",
  };
  return {
    owner,
    profileId,
    credential,
    replacement,
    replace: () => setProfile(profileId, { credential: replacement }),
  };
}

type PersonalFixture = ReturnType<typeof fixture>;
const it = baseIt.extend<
  PersonalFixture & {
    state: PersonalFixture;
    readCurrent: Awaited<ReturnType<typeof prepareCredentialReader>>;
  }
>({
  state: async ({ task: _task }, use) => {
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async () => use(fixture()));
    } finally {
      vi.restoreAllMocks();
    }
  },
  owner: async ({ state }, use) => use(state.owner),
  profileId: async ({ state }, use) => use(state.profileId),
  credential: async ({ state }, use) => use(state.credential),
  replacement: async ({ state }, use) => use(state.replacement),
  replace: async ({ state }, use) => use(state.replace),
  readCurrent: async ({ profileId }, use) => use(await prepareCredentialReader(profileId)),
});

function setProfile(profileId: string, fields: Partial<UserModelAuthProfile>) {
  updateUserModelAuthProfile(profileId, (profile) => {
    Object.assign(profile, fields);
    return true;
  });
}

function trackReplacements() {
  const tracked: { target?: { worker: Worker; id: number }; attempts: number } = { attempts: 0 };
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted worker receiver.
  const post = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (isRecord(command) && command.type === "authProfiles.personalReplace") {
        tracked.attempts++;
        tracked.target = { worker: this, id: request.id };
      }
    }
    return post.call(this, request, transferList);
  });
  return tracked;
}

function writeCredential(
  profileId: string,
  credential: OAuthCredential,
  assertCurrent?: () => void,
) {
  return withPersonalAuthProfileStore(profileId, (owner) =>
    owner.update((store) => {
      store.profiles[profileId] = credential;
      return true;
    }, assertCurrent),
  );
}

async function prepareCredentialReader(profileId: string) {
  return expectDefined(
    await withPersonalAuthProfileStore(profileId, async (owner) => {
      await owner.read();
      return owner.readCurrentCredential;
    }),
    "prepared personal credential reader",
  );
}

async function expectPreparedFetchRevoked(
  readCurrent: () => unknown,
  mutateDuringDns: () => Promise<unknown>,
) {
  const fetchImpl = vi.fn(async () => new Response("ok"));
  const beforeRequest = vi.fn(() => {
    readCurrent();
  });
  await expect(
    fetchWithSsrFGuard({
      url: "https://public.example/resource",
      capture: false,
      fetchImpl,
      lookupFn: async () => {
        await mutateDuringDns();
        return [{ address: "93.184.216.34", family: 4 }];
      },
      beforeRequest,
    }),
  ).rejects.toThrow(authorityUnavailable);
  expect(beforeRequest).toHaveBeenCalledOnce();
  expect(fetchImpl).not.toHaveBeenCalled();
}

it("keeps an unlinked pin database-free", async ({ owner, credential, readCurrent }) => {
  await clearUserProfileAuthLinkAsync({
    profileId: owner.id,
    provider: credential.provider,
    assertCurrent() {},
  });
  await withoutDatabase(() => expect(readCurrent()).toEqual(credential));
});

it("revokes same-byte reconnects", async ({ owner, profileId, credential, readCurrent }) => {
  await expectPreparedFetchRevoked(readCurrent, async () => {
    const connected = await connectUserModelAccountAsync({
      ownerProfileId: owner.id,
      credential,
      matchesCredential: () => true,
      assertCurrent() {},
    });
    expect(connected.authProfileId).toBe(profileId);
  });
  expectUnavailable(readCurrent);
  const readReconnected = await prepareCredentialReader(profileId);
  expect(readReconnected()).toEqual(credential);
  expectUnavailable(readCurrent);
});

it.for(["commit", "rollback"] as const)(
  "denies personal credential use during refresh and publishes only the %s outcome",
  async (outcome, { profileId, credential, replacement, readCurrent }) => {
    let admissions = 0;
    const refused = new Error("Synthetic final credential write refusal");
    const update = writeCredential(profileId, replacement, () => {
      admissions++;
      expectUnavailable(readCurrent);
      if (outcome === "rollback" && admissions === 2) {
        throw refused;
      }
    });
    if (outcome === "rollback") {
      await expect(update).rejects.toThrow(refused.message);
    } else {
      await expect(update).resolves.toMatchObject({ profiles: { [profileId]: replacement } });
    }
    expect(admissions).toBe(2);
    expect(readCurrent()).toEqual(outcome === "commit" ? replacement : credential);
  },
);

it("waits for all overlapping admissions", async ({ credential, readCurrent }) => {
  const context = captureOpenClawStateWorkerContext();
  const createAdmission = withPersonalCredentialPublication(
    createSqliteWorkerWriteAdmission(() => {}, [context.admission.databasePath]),
    context,
  );
  const first = createDeferredCore<SqliteWorkerOperationSettlement>();
  const second = createDeferredCore<SqliteWorkerOperationSettlement>();
  const admissions = [
    createAdmission({ settled: first.promise }).admission,
    createAdmission({ settled: second.promise }).admission,
  ];
  try {
    expectUnavailable(readCurrent);
    first.resolve({ kind: "not-entered", error: new Error("Synthetic admission refusal") });
    await first.promise;
    expectUnavailable(readCurrent);
    second.resolve({ kind: "completed" });
    await second.promise;
    expect(readCurrent()).toEqual(credential);
  } finally {
    first.resolve({ kind: "completed" });
    second.resolve({ kind: "completed" });
    for (const admission of admissions) {
      admission.finish();
    }
  }
});

it("revokes merged and aliased pins", async ({ owner, profileId, credential }) => {
  const target = ensureProfileForEmail("personal-merge-target@example.test");
  const successor = ensureProfileForEmail("personal-merge-successor@example.test");
  const readSource = await prepareCredentialReader(profileId);
  await expectPreparedFetchRevoked(readSource, () =>
    mergeCanonicalUserProfiles(owner.id, target.id),
  );
  expectUnavailable(readSource);
  const readTransferred = await prepareCredentialReader(profileId);
  expect(readTransferred()).toEqual(credential);
  await mergeCanonicalUserProfiles(target.id, successor.id);
  expectUnavailable(readTransferred);
  expect((await prepareCredentialReader(profileId))()).toEqual(credential);
  expectUnavailable(readSource);
});

it("rejects a cold read retired by reconnect", async ({ owner, profileId, credential }) => {
  let reconnect = true;
  probe.command(workerStore, async (command, executeOptions, scope) => {
    const result = await scope.execute(command, executeOptions);
    if (command.type === "authProfiles.personal" && reconnect) {
      reconnect = false;
      await connectUserModelAccountAsync({
        ownerProfileId: owner.id,
        credential,
        matchesCredential: () => true,
        assertCurrent() {},
      });
    }
    return result;
  });
  await expect(prepareCredentialReader(profileId)).rejects.toThrow(authorityUnavailable);
  expect((await prepareCredentialReader(profileId))()).toEqual(credential);
});

it("withholds keys from canceled worker reads", async ({ profileId }) => {
  setProfile(profileId, {
    credential: { type: "api_key", provider: "synthetic", key: "synthetic-key" },
  });
  const controller = new AbortController();
  const reason = new Error("Synthetic credential read cancellation");
  probe.command(workerStore, (command, executeOptions, scope) => {
    if (command.type === "authProfiles.personal") {
      controller.abort(reason);
    }
    return scope.execute(command, executeOptions);
  });
  await expect(
    resolveApiKeyForProfile({
      profileId,
      store: { version: 1, profiles: {} },
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
});

it.for([false, true])(
  "persists a quota recheck with available=%s",
  async (available, { profileId, credential }) => {
    const now = 1_800_000_000_000;
    const blocked: ProfileUsageStats = {
      blockedUntil: now + 86_400_000,
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      lastProbeAt: now - 600_000,
    };
    setProfile(profileId, { usageStats: blocked });
    const result = await withPersonalAuthProfileStore(profileId, async (owner) => {
      await owner.update((store) => {
        expectDefined(store.usageStats?.[profileId], "seeded quota").lastProbeAt = now;
        return true;
      });
      return owner.update((store) => {
        const stats = expectDefined(store.usageStats?.[profileId], "claimed quota");
        const quota: WhamCooldownProbeResult = available
          ? { available: true, cooldownMs: 0 }
          : { blockedUntil: blocked.blockedUntil, cooldownMs: 0 };
        Object.assign(stats, reconcileWhamBlock(stats, quota, now));
        return true;
      });
    });
    const expected = {
      credential,
      usageStats: available ? { lastProbeAt: now } : { ...blocked, lastProbeAt: now },
    };
    expect(readUserModelAuthProfile(profileId)).toStrictEqual(expected);
    expect(result?.usageStats?.[profileId]).toStrictEqual(expected.usageStats);
  },
);

it.for(["capability", "format"] as const)(
  "rejects stale credentials across awaited provider %s preparation",
  async (stage, { profileId, credential, replacement, replace }) => {
    const refreshCredential = vi.fn(async () => replacement);
    let changed = false;
    const manager = managerWith({
      canRefreshCredential: async () => {
        if (stage === "capability") {
          replace();
        }
        return true;
      },
      refreshCredential,
      buildApiKey: async (_provider, current) => {
        if (stage === "format" && !changed) {
          changed = true;
          replace();
        }
        return current.access;
      },
    });
    if (stage === "format") {
      setProfile(profileId, { credential: { ...credential, expires: Date.now() + 600_000 } });
    }
    const resolving = resolve(manager, profileId, credential);
    if (stage === "format") {
      await expect(resolving).rejects.toThrow("changed during provider preparation");
    } else {
      expect((await resolving)?.credential).toEqual(replacement);
    }
    expect(refreshCredential).not.toHaveBeenCalled();
    expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
  },
);

it("normalizes refreshed optionals once", async ({ profileId, credential, replacement }) => {
  const refreshCredential = vi.fn(async () => ({ ...replacement, displayName: undefined }));
  const buildApiKey = vi.fn(async (_provider: string, current: OAuthCredential) => current.access);
  const manager = managerWith({ refreshCredential, buildApiKey });
  const result = await resolve(manager, profileId, credential);
  expect(result).toStrictEqual({ apiKey: replacement.access, credential: replacement });
  expect(readUserModelAuthProfile(profileId)?.credential).toStrictEqual(replacement);
  expect(refreshCredential).toHaveBeenCalledTimes(1);
  expect(buildApiKey).toHaveBeenCalledTimes(1);
});

it("rechecks live pins after refresh", async ({ owner, profileId, credential, replacement }) => {
  const successor = ensureProfileForEmail("personal-successor@example.test");
  const pin = await prepareUserModelAccountAuthority({
    profileId: owner.id,
    authProfileId: profileId,
  });
  expect(pin).toBeDefined();
  const manager = managerWith({
    refreshCredential: async () => {
      linkEmail("personal-race@example.test", successor.id);
      return replacement;
    },
  });
  await expect(
    resolve(manager, profileId, credential, {
      validateCredential() {
        if (!pin?.isCurrent()) {
          throw new Error("Synthetic pin revoked");
        }
      },
    }),
  ).rejects.toThrow("Synthetic pin revoked");
  expect(readUserModelAuthProfile(profileId)?.credential).not.toEqual(replacement);
});

it("accepts published credentials database-free", async ({
  profileId,
  credential,
  replacement,
  replace,
}) => {
  const observe = vi.fn<(observation: CanonicalAuthProfileCredentialObservation) => void>();
  await withPersonalAuthProfileStore(profileId, async (owner) => {
    await owner.read();
    await withCanonicalAuthProfileCredentialObserver(observe, async () => {
      expect(await withoutDatabase(() => owner.accept(credential))).toEqual(credential);
      replace();
      await expect(withoutDatabase(() => owner.accept(credential))).rejects.toThrow(
        "changed during provider preparation",
      );
      const manager = managerWith({
        canRefreshCredential: async () => false,
      });
      expect(
        await withoutDatabase(() =>
          resolve(manager, profileId, credential, { personalStore: owner }),
        ),
      ).toEqual({ apiKey: replacement.access, credential: replacement });
    });
    expect(observe.mock.calls.map(([value]) => value.profiles[profileId])).toEqual([
      credential,
      replacement,
    ]);
  });
});

it("retains the original personal generation when provider refresh mutates its input", async ({
  profileId,
  credential,
  replacement,
}) => {
  const manager = managerWith({
    refreshCredential: async (input) => {
      input.accountId = "synthetic-other-account";
      return { ...replacement, accountId: input.accountId };
    },
  });
  await expect(resolve(manager, profileId, credential)).rejects.toThrow("different OAuth account");
  expect(readUserModelAuthProfile(profileId)?.credential).toMatchObject({
    type: "oauth",
    accountId: credential.accountId,
  });
});

it.for(["conflict", "unknown"] as const)(
  "does not replay a personal update after %s",
  async (outcome, { profileId, credential, replacement, replace }) => {
    let attempts = 0;
    probe.command(workerStore, (command, executeOptions, scope) => {
      if (command.type === "authProfiles.personalReplace") {
        attempts++;
        if (outcome === "unknown") {
          throw new SqliteWorkerError("Synthetic transport uncertainty", "outcome-unknown");
        }
      }
      return scope.execute(command, executeOptions);
    });
    const updater = vi.fn((store) => {
      if (outcome === "conflict") {
        replace();
      }
      store.profiles[profileId] = { ...replacement, access: "synthetic-stale-candidate" };
      return true;
    });
    const failure = await withPersonalAuthProfileStore(profileId, (owner) =>
      owner.update(updater),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(outcome === "unknown");
    expect(updater).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(1);
    expect(readUserModelAuthProfile(profileId)?.credential).toEqual(
      outcome === "conflict" ? replacement : credential,
    );
  },
);

it("waits for the native commit receipt", async ({ profileId, replacement, readCurrent }) => {
  const observe = operationAdmission.observeSqliteWorkerCommittedFacts;
  let heldReceipt = false;
  vi.spyOn(operationAdmission, "observeSqliteWorkerCommittedFacts").mockImplementation(
    (admission, publish) =>
      observe(admission, (receipt) => {
        if (isRecord(receipt.facts) && receipt.facts.personalCredentials) {
          heldReceipt = true;
          expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
          const sql = observeMainThreadSql();
          const requests = vi.spyOn(Worker.prototype, "postMessage");
          try {
            expectUnavailable(readCurrent);
            sql.expectIdle();
            expect(requests).not.toHaveBeenCalled();
          } finally {
            sql.restore();
            requests.mockRestore();
          }
        }
        publish(receipt);
      }),
  );
  await writeCredential(profileId, replacement);
  expect(heldReceipt).toBe(true);
  expect(readCurrent()).toEqual(replacement);
});

it.for(["unacknowledged", "acknowledged"] as const)(
  "preserves the correct postimage after %s worker death",
  async (stage, { profileId, replacement, readCurrent }) => {
    const acknowledged = { ...replacement };
    const tracked = trackReplacements();
    let terminated: Promise<number> | undefined;
    probe.admission(operationAdmission, (request, grant, admit) => {
      if (stage === "unacknowledged" && tracked.target && request.stage === "commit") {
        expectUnavailable(readCurrent);
        terminated = tracked.target.worker.terminate();
      } else {
        admit(request, grant);
      }
    });
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted worker receiver.
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event,
      ...args: unknown[]
    ) {
      const reply = args[0];
      if (
        stage === "acknowledged" &&
        event === "message" &&
        !terminated &&
        tracked.target?.worker === this &&
        isRecord(reply) &&
        reply.id === tracked.target.id &&
        reply.ok === true
      ) {
        replacement.access = "synthetic-late-draft-mutation";
        terminated = this.terminate();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    try {
      let failure: unknown;
      const result = await withPersonalAuthProfileStore(profileId, (owner) =>
        owner.update((store) => {
          if (stage === "acknowledged") {
            replacement.idToken = undefined;
            store.usageStats = { [profileId]: { lastProbeAt: 123, blockedUntil: undefined } };
          }
          store.profiles[profileId] = replacement;
          return true;
        }),
      ).catch((error: unknown) => {
        failure = error;
        return undefined;
      });
      expect(terminated).toBeDefined();
      if (stage === "unacknowledged") {
        expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
        expectUnavailable(readCurrent);
        await expect(prepareCredentialReader(profileId)).rejects.toThrow();
      } else {
        expect(failure).toBeUndefined();
        expect(result?.profiles[profileId]).toStrictEqual(acknowledged);
        expect(result?.usageStats?.[profileId]).toStrictEqual({ lastProbeAt: 123 });
        await terminated;
        expect(tracked.attempts).toBe(1);
        expect(readUserModelAuthProfile(profileId)?.credential).toEqual(acknowledged);
        expect(readCurrent()).toEqual(acknowledged);
      }
    } finally {
      await terminated;
    }
  },
);

it.for(["canonical", "merged"] as const)(
  "preserves an unchanged %s personal grant after a retryable failure and recovers",
  async (identity, { owner, profileId, credential, replacement }) => {
    if (identity === "merged") {
      const target = ensureProfileForEmail("personal-retry-merged@example.test");
      await mergeCanonicalUserProfiles(owner.id, target.id);
    }
    const refreshCredential = vi
      .fn()
      .mockRejectedValueOnce(nonattemptedRefresh())
      .mockResolvedValueOnce(replacement);
    const manager = managerWith({ refreshCredential });
    await expect(resolve(manager, profileId, credential)).rejects.toThrow();
    expect(readUserModelAuthProfile(profileId)?.credential).toEqual(credential);
    expect(readUserModelAuthProfile(profileId)?.usageStats).toBeUndefined();
    await expect(resolve(manager, profileId, credential)).resolves.toMatchObject({
      apiKey: replacement.access,
    });
    expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
    expect(refreshCredential).toHaveBeenCalledTimes(2);
  },
);

it.for(["disconnect", "reassignment", "same-account-reassignment"] as const)(
  "rejects retired personal authority after transient %s",
  async (change, { owner, profileId, credential, replacement }) => {
    const current = captureUserProfileModelAccountLinksAuthority(
      captureOpenClawStateWorkerContext().admission,
      owner.id,
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const buildApiKey = vi.fn(async () => "should-not-publish");
    const refreshCredential = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      throw nonattemptedRefresh();
    });
    const manager = managerWith({ refreshCredential, buildApiKey });
    const pending = resolve(manager, profileId, credential).catch((error: unknown) => error);
    try {
      await entered.promise;
      const reconnected = {
        ...replacement,
        accountId:
          change === "same-account-reassignment" ? credential.accountId : "replacement-account",
      };
      if (change === "disconnect") {
        clearUserProfileAuthLink({ profileId: owner.id, provider: credential.provider });
      } else {
        connectUserModelAccount({
          ownerProfileId: owner.id,
          credential: reconnected,
          replacement: readSelectedUserModelAccount(owner.id, credential.provider),
          assertCurrent() {},
        });
      }
      expect(current()).toBe(false);
      release.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(buildApiKey).not.toHaveBeenCalled();
      expect(refreshCredential).toHaveBeenCalledTimes(1);
      const stored = readUserModelAuthProfile(profileId)?.credential;
      if (change === "disconnect") {
        const oauth = stored?.type === "oauth" ? stored : undefined;
        expect(isOAuthRefreshFence(oauth)).toBe(true);
        expect(isPendingOAuthRefreshFence(oauth)).toBe(false);
      } else {
        expect(stored).toEqual(reconnected);
      }
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.for(["disconnect", "link-switch", "merge"] as const)(
  "does not revive a merged owner's grant after transient %s",
  async (change, { owner, profileId, credential, replacement }) => {
    const target = ensureProfileForEmail("personal-refresh-merged@example.test");
    const other = connectUserModelAccount({
      ownerProfileId: target.id,
      credential: { ...replacement, accountId: "other-existing-account" },
      assertCurrent() {},
    });
    await mergeCanonicalUserProfiles(owner.id, target.id);
    setUserProfileAuthLink({
      profileId: target.id,
      provider: credential.provider,
      authProfileId: profileId,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const refreshCredential = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      throw nonattemptedRefresh();
    });
    const buildApiKey = vi.fn(async () => "should-not-publish");
    const manager = managerWith({ refreshCredential, buildApiKey });
    const pending = resolve(manager, profileId, credential).catch((error: unknown) => error);
    try {
      await entered.promise;
      const fenced = readUserModelAuthProfile(profileId)?.credential;
      expect(fenced?.type === "oauth" && isPendingOAuthRefreshFence(fenced)).toBe(true);
      if (change === "disconnect") {
        clearUserProfileAuthLink({ profileId: target.id, provider: credential.provider });
      } else if (change === "link-switch") {
        setUserProfileAuthLink({
          profileId: target.id,
          provider: credential.provider,
          authProfileId: other.authProfileId,
        });
      } else {
        const successor = ensureProfileForEmail("personal-refresh-successor@example.test");
        await mergeCanonicalUserProfiles(target.id, successor.id);
      }
      // Changing only selection/ownership must not replace the old credential row.
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(fenced);
      release.resolve();
      expect(await pending).toBeInstanceOf(Error);
      const stored = readUserModelAuthProfile(profileId)?.credential;
      const oauth = stored?.type === "oauth" ? stored : undefined;
      expect(isOAuthRefreshFence(oauth)).toBe(true);
      expect(isPendingOAuthRefreshFence(oauth)).toBe(false);
      expect(buildApiKey).not.toHaveBeenCalled();
      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(readUserModelAuthProfile(other.authProfileId)?.credential).toEqual({
        ...replacement,
        accountId: "other-existing-account",
      });
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it("rechecks captured personal authority before persisting the refresh claim", async ({
  owner,
  profileId,
  credential,
}) => {
  const captured = createDeferredCore();
  const release = createDeferredCore();
  const refreshCredential = vi.fn();
  const manager = managerWith({ refreshCredential });
  await withPersonalAuthProfileStore(profileId, async (store) => {
    await store.read();
    const capture = store.captureRefreshAuthority.bind(store);
    vi.spyOn(store, "captureRefreshAuthority").mockImplementation(async () => {
      const assertCurrent = await capture();
      captured.resolve();
      await release.promise;
      return assertCurrent;
    });
    const pending = resolve(manager, profileId, credential, { personalStore: store }).catch(
      (error: unknown) => error,
    );
    try {
      await captured.promise;
      clearUserProfileAuthLink({ profileId: owner.id, provider: credential.provider });
      release.resolve();
      expect(await pending).toMatchObject({
        message: expect.stringContaining("selection changed during refresh"),
      });
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(credential);
      expect(refreshCredential).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  });
});

it("does not persist a refresh claim when personal authority capture fails", async ({
  profileId,
  credential,
}) => {
  const refreshCredential = vi.fn();
  const manager = managerWith({ refreshCredential });
  const failure = new Error("synthetic refresh authority unavailable");
  await withPersonalAuthProfileStore(profileId, async (owner) => {
    await owner.read();
    vi.spyOn(owner, "captureRefreshAuthority").mockImplementation(() => {
      throw failure;
    });
    await expect(resolve(manager, profileId, credential, { personalStore: owner })).rejects.toThrow(
      failure.message,
    );
    expect(readUserModelAuthProfile(profileId)?.credential).toEqual(credential);
    expect(refreshCredential).not.toHaveBeenCalled();
  });
});

it("leaves the writer free while the host decides auth authorization enrollment", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profileId = "synthetic:enrollment";
    const context = captureOpenClawStateWorkerContext();
    const expected = runOpenClawStateWriteTransaction(({ db }) => {
      writeAuthProfileJsonCell(db, "store", "shared-state", {
        version: 1,
        profiles: {
          [profileId]: { type: "token", provider: "synthetic", token: "synthetic-token" },
        },
      });
      return inspectAuthProfileJsonCell(db, "store", "shared-state");
    }, {});
    const databasePath = resolveOpenClawStateSqlitePath();
    using contention = probe.writerLock(databasePath);
    probe.admission(operationAdmission, (request, grant, admit) => {
      contention.observe(request.stage);
      admit(request, grant);
    });
    const enrolled = await workerStore.runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({ type: "authProfiles.enrollAuthorization", input: { profileId, expected } }),
      {
        assertCurrent: () => {},
        createAdmission: createSqliteWorkerWriteAdmission(() => {}, [databasePath]),
      },
    );
    expect(contention.observed).toEqual(["transaction:free", "commit:held"]);
    expect(enrolled.raw).toMatchObject({
      authorizationLifetimes: { [profileId]: expect.any(String) },
    });
    expect(
      runOpenClawStateWriteTransaction(
        ({ db }) => inspectAuthProfileJsonCell(db, "store", "shared-state"),
        {},
      ),
    ).toEqual({ status: "readable", raw: enrolled.raw });
  });
});
