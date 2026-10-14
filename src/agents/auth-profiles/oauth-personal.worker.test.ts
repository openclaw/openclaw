import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
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
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { withPersonalCredentialPublication } from "../../state/user-model-account-authority.js";
import {
  clearUserProfileAuthLinkAsync,
  connectUserModelAccountAsync,
  prepareUserModelAccountAuthority,
} from "../../state/user-model-account-operations.js";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
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
import { resolveApiKeyForProfile } from "./oauth.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import type { OAuthCredential, ProfileUsageStats } from "./types.js";
import { reconcileWhamBlock } from "./usage-reduction.js";

afterEach(() => vi.restoreAllMocks());

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
    replace: () => {
      updateUserModelAuthProfile(profileId, (profile) => {
        profile.credential = replacement;
        return true;
      });
    },
  };
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
  ).rejects.toThrow("Personal model account authority is unavailable");
  expect(beforeRequest).toHaveBeenCalledOnce();
  expect(fetchImpl).not.toHaveBeenCalled();
}

it("retains a personal credential pin across unlink without SQL or worker requests at use", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, profileId, credential } = fixture();
    const readCurrent = await prepareCredentialReader(profileId);
    await clearUserProfileAuthLinkAsync({
      profileId: owner.id,
      provider: credential.provider,
      assertCurrent() {},
    });
    const sql = observeMainThreadSql();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      expect(readCurrent()).toEqual(credential);
      sql.expectIdle();
      expect(requests).not.toHaveBeenCalled();
    } finally {
      sql.restore();
      requests.mockRestore();
    }
  });
});

it("retires an already prepared credential when reconnect keeps the same ID and token bytes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, profileId, credential } = fixture();
    const readCurrent = await prepareCredentialReader(profileId);
    await expectPreparedFetchRevoked(readCurrent, async () => {
      const connected = await connectUserModelAccountAsync({
        ownerProfileId: owner.id,
        credential,
        matchesCredential: () => true,
        assertCurrent() {},
      });
      expect(connected.authProfileId).toBe(profileId);
    });
    expect(readCurrent).toThrow("Personal model account authority is unavailable");
    const readReconnected = await prepareCredentialReader(profileId);
    expect(readReconnected()).toEqual(credential);
    expect(readCurrent).toThrow("Personal model account authority is unavailable");
  });
});

it.each(["commit", "rollback"] as const)(
  "denies personal credential use during refresh and publishes only the %s outcome",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { profileId, credential, replacement } = fixture();
      const readCurrent = await prepareCredentialReader(profileId);
      let admissions = 0;
      const refused = new Error("Synthetic final credential write refusal");
      const update = withPersonalAuthProfileStore(profileId, (owner) =>
        owner.update(
          (store) => {
            store.profiles[profileId] = replacement;
            return true;
          },
          () => {
            admissions++;
            expect(readCurrent).toThrow("Personal model account authority is unavailable");
            if (outcome === "rollback" && admissions === 2) {
              throw refused;
            }
          },
        ),
      );
      if (outcome === "rollback") {
        await expect(update).rejects.toThrow(refused.message);
      } else {
        await expect(update).resolves.toMatchObject({ profiles: { [profileId]: replacement } });
      }
      expect(admissions).toBe(2);
      expect(readCurrent()).toEqual(outcome === "commit" ? replacement : credential);
    });
  },
);

it("keeps credentials unavailable until every overlapping admission has settled", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, credential } = fixture();
    const readCurrent = await prepareCredentialReader(profileId);
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
      expect(readCurrent).toThrow("Personal model account authority is unavailable");
      first.resolve({ kind: "not-entered", error: new Error("Synthetic admission refusal") });
      await first.promise;
      expect(readCurrent).toThrow("Personal model account authority is unavailable");
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
});

it("retires source and flattened-alias credentials when merge transfers identical bytes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, profileId, credential } = fixture();
    const target = ensureProfileForEmail("personal-merge-target@example.test");
    const successor = ensureProfileForEmail("personal-merge-successor@example.test");
    const readSource = await prepareCredentialReader(profileId);
    await expectPreparedFetchRevoked(readSource, () =>
      mergeCanonicalUserProfiles(owner.id, target.id),
    );
    expect(readSource).toThrow("Personal model account authority is unavailable");
    const readTransferred = await prepareCredentialReader(profileId);
    expect(readTransferred()).toEqual(credential);
    await mergeCanonicalUserProfiles(target.id, successor.id);
    expect(readTransferred).toThrow("Personal model account authority is unavailable");
    expect((await prepareCredentialReader(profileId))()).toEqual(credential);
    expect(readSource).toThrow("Personal model account authority is unavailable");
  });
});

it("does not install a cold credential read after reconnect has retired its authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, profileId, credential } = fixture();
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
    await expect(prepareCredentialReader(profileId)).rejects.toThrow(
      "Personal model account authority is unavailable",
    );
    expect((await prepareCredentialReader(profileId))()).toEqual(credential);
  });
});

it("does not disclose a personal API key when its worker read is canceled", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId } = fixture();
    updateUserModelAuthProfile(profileId, (profile) => {
      profile.credential = { type: "api_key", provider: "synthetic", key: "synthetic-key" };
      return true;
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
});

it.each([false, true])("persists a quota recheck with available=%s", async (available) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, credential } = fixture();
    const now = 1_800_000_000_000;
    const blocked: ProfileUsageStats = {
      blockedUntil: now + 86_400_000,
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      lastProbeAt: now - 600_000,
    };
    updateUserModelAuthProfile(profileId, (profile) => {
      profile.usageStats = blocked;
      return true;
    });
    const result = await withPersonalAuthProfileStore(profileId, async (owner) => {
      await owner.update((store) => {
        expectDefined(store.usageStats?.[profileId], "seeded quota").lastProbeAt = now;
        return true;
      });
      return owner.update((store) => {
        const stats = expectDefined(store.usageStats?.[profileId], "claimed quota");
        Object.assign(
          stats,
          reconcileWhamBlock(
            stats,
            available
              ? { available: true, cooldownMs: 0 }
              : { blockedUntil: blocked.blockedUntil, cooldownMs: 0 },
            now,
          ),
        );
        return true;
      });
    });
    const expected = {
      credential,
      usageStats: available ? { lastProbeAt: now } : { ...blocked, lastProbeAt: now },
    };
    expect(readUserModelAuthProfile(profileId)).toStrictEqual(expected);
    expect(result?.usageStats?.[profileId]).toStrictEqual(expected.usageStats);
  });
});

it.each(["capability", "format"] as const)(
  "rejects stale credentials across awaited provider %s preparation",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { profileId, credential, replacement, replace } = fixture();
      const refreshCredential = vi.fn(async () => replacement);
      let changed = false;
      const manager = createOAuthManager({
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
        readBootstrapCredential: () => null,
      });
      if (stage === "format") {
        updateUserModelAuthProfile(profileId, (profile) => {
          profile.credential = { ...credential, expires: Date.now() + 600_000 };
          return true;
        });
      }
      const resolving = manager.resolveOAuthAccess({
        store: { version: 1, profiles: { [profileId]: credential } },
        profileId,
        credential,
      });
      if (stage === "format") {
        await expect(resolving).rejects.toThrow("changed during provider preparation");
      } else {
        expect((await resolving)?.credential).toEqual(replacement);
      }
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
    });
  },
);

it("accepts refreshed credentials with undefined optionals without repeating provider preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, credential, replacement } = fixture();
    const refreshCredential = vi.fn(async () => ({ ...replacement, displayName: undefined }));
    const buildApiKey = vi.fn(
      async (_provider: string, current: OAuthCredential) => current.access,
    );
    const manager = createOAuthManager({
      canRefreshCredential: async () => true,
      refreshCredential,
      buildApiKey,
      readBootstrapCredential: () => null,
    });
    const result = await manager.resolveOAuthAccess({
      profileId,
      credential,
      store: { version: 1, profiles: { [profileId]: credential } },
    });
    expect(result).toStrictEqual({ apiKey: replacement.access, credential: replacement });
    expect(readUserModelAuthProfile(profileId)?.credential).toStrictEqual(replacement);
    expect(refreshCredential).toHaveBeenCalledTimes(1);
    expect(buildApiKey).toHaveBeenCalledTimes(1);
  });
});

it("rechecks a live pin after refresh and never discloses a revoked selection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { owner, profileId, credential, replacement } = fixture();
    const successor = ensureProfileForEmail("personal-successor@example.test");
    const pin = await prepareUserModelAccountAuthority({
      profileId: owner.id,
      authProfileId: profileId,
    });
    expect(pin).toBeDefined();
    const manager = createOAuthManager({
      canRefreshCredential: async () => true,
      refreshCredential: async () => {
        linkEmail("personal-race@example.test", successor.id);
        return replacement;
      },
      buildApiKey: async (_provider, value) => value.access,
      readBootstrapCredential: () => null,
    });
    await expect(
      manager.resolveOAuthAccess({
        store: { version: 1, profiles: { [profileId]: credential } },
        profileId,
        credential,
        validateCredential() {
          if (!pin?.isCurrent()) {
            throw new Error("Synthetic pin revoked");
          }
        },
      }),
    ).rejects.toThrow("Synthetic pin revoked");
    expect(readUserModelAuthProfile(profileId)?.credential).not.toEqual(replacement);
  });
});

it("resolves and accepts published personal credentials without SQL or worker requests", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, credential, replacement, replace } = fixture();
    const observe = vi.fn<(observation: CanonicalAuthProfileCredentialObservation) => void>();
    await withPersonalAuthProfileStore(profileId, async (owner) => {
      await owner.read();
      const withoutDatabase = async <T>(run: () => Promise<T>) => {
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
      };
      await withCanonicalAuthProfileCredentialObserver(observe, async () => {
        expect(await withoutDatabase(() => owner.accept(credential))).toEqual(credential);
        replace();
        await expect(withoutDatabase(() => owner.accept(credential))).rejects.toThrow(
          "changed during provider preparation",
        );
        const manager = createOAuthManager({
          canRefreshCredential: async () => false,
          refreshCredential: async () => null,
          buildApiKey: async (_provider, current) => current.access,
          readBootstrapCredential: () => null,
        });
        expect(
          await withoutDatabase(() =>
            manager.resolveOAuthAccess({
              personalStore: owner,
              profileId,
              credential,
              store: { version: 1, profiles: { [profileId]: credential } },
            }),
          ),
        ).toEqual({ apiKey: replacement.access, credential: replacement });
      });
      expect(observe.mock.calls.map(([value]) => value.profiles[profileId])).toEqual([
        credential,
        replacement,
      ]);
    });
  });
});

it.each(["capability", "refresh"] as const)(
  "retains the original personal generation when the %s adapter mutates its input",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { profileId, credential, replacement } = fixture();
      const manager = createOAuthManager({
        canRefreshCredential: async (input) => {
          if (stage === "capability") {
            input.accountId = "synthetic-other-account";
          }
          return true;
        },
        refreshCredential: async (input) => {
          if (stage === "refresh") {
            input.accountId = "synthetic-other-account";
          }
          return { ...replacement, accountId: input.accountId };
        },
        buildApiKey: async (_provider, value) => value.access,
        readBootstrapCredential: () => null,
      });
      const resolving = manager.resolveOAuthAccess({
        profileId,
        credential,
        store: { version: 1, profiles: { [profileId]: credential } },
      });
      if (stage === "capability") {
        expect(await resolving).toEqual({ apiKey: replacement.access, credential: replacement });
      } else {
        await expect(resolving).rejects.toThrow("different OAuth account");
      }
      expect(readUserModelAuthProfile(profileId)?.credential).toMatchObject({
        type: "oauth",
        accountId: credential.accountId,
      });
    });
  },
);

it.each(["conflict", "unknown"] as const)(
  "does not replay a personal update after %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { profileId, credential, replacement, replace } = fixture();
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
    });
  },
);

it("denies credential use after native commit until the owner receives its receipt", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, replacement } = fixture();
    const readCurrent = await prepareCredentialReader(profileId);
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
              expect(readCurrent).toThrow("Personal model account authority is unavailable");
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
    await withPersonalAuthProfileStore(profileId, (owner) =>
      owner.update((store) => {
        store.profiles[profileId] = replacement;
        return true;
      }),
    );
    expect(heldReceipt).toBe(true);
    expect(readCurrent()).toEqual(replacement);
  });
});

it("denies a retained credential after worker death without a commit acknowledgment", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, replacement } = fixture();
    const readCurrent = await prepareCredentialReader(profileId);
    let target: { worker: Worker } | undefined;
    let terminated: Promise<number> | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (isRecord(command) && command.type === "authProfiles.personalReplace") {
          target = { worker: this };
        }
      }
      return post.call(this, request, transferList);
    });
    probe.admission(operationAdmission, (request, grant, admit) => {
      if (target && request.stage === "commit") {
        expect(readCurrent).toThrow("Personal model account authority is unavailable");
        terminated = target.worker.terminate();
        return;
      }
      admit(request, grant);
    });
    try {
      const failure = await withPersonalAuthProfileStore(profileId, (owner) =>
        owner.update((store) => {
          store.profiles[profileId] = replacement;
          return true;
        }),
      ).catch((error: unknown) => error);
      expect(terminated).toBeDefined();
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
      expect(readCurrent).toThrow("Personal model account authority is unavailable");
      await expect(prepareCredentialReader(profileId)).rejects.toThrow();
    } finally {
      await terminated;
    }
  });
});

it("publishes only the exact acknowledged personal postimage when its result frame is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, replacement } = fixture();
    const readCurrent = await prepareCredentialReader(profileId);
    const acknowledged = { ...replacement };
    let target: { worker: Worker; id: number } | undefined;
    let terminated: Promise<number> | undefined;
    let attempts = 0;
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
    const post = Worker.prototype.postMessage;
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (isRecord(command) && command.type === "authProfiles.personalReplace") {
          attempts++;
          target = { worker: this, id: request.id };
        }
      }
      return post.call(this, request, transferList);
    });
    vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event,
      ...args: unknown[]
    ) {
      const reply = args[0];
      if (
        event === "message" &&
        !terminated &&
        target?.worker === this &&
        isRecord(reply) &&
        reply.id === target.id &&
        reply.ok === true
      ) {
        replacement.access = "synthetic-late-draft-mutation";
        terminated = this.terminate();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    try {
      const result = await withPersonalAuthProfileStore(profileId, (owner) =>
        owner.update((store) => {
          replacement.idToken = undefined;
          store.profiles[profileId] = replacement;
          store.usageStats = { [profileId]: { lastProbeAt: 123, blockedUntil: undefined } };
          return true;
        }),
      );
      expect(result?.profiles[profileId]).toStrictEqual(acknowledged);
      expect(result?.usageStats?.[profileId]).toStrictEqual({ lastProbeAt: 123 });
      expect(terminated).toBeDefined();
      await terminated;
      expect(attempts).toBe(1);
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(acknowledged);
      expect(readCurrent()).toEqual(acknowledged);
    } finally {
      await terminated;
    }
  });
});
