import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerRequest,
} from "../../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { prepareUserModelAccountAuthority } from "../../state/user-model-account-operations.js";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
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

it.each(["formatter", "validator"] as const)(
  "returns and publishes the credential accepted before a late %s mutation",
  async (source) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { profileId, replacement, replace } = fixture();
      replace();
      let formatted: OAuthCredential | undefined;
      let accepting = false;
      let mutationScheduled = false;
      const observe = vi.fn<(observation: CanonicalAuthProfileCredentialObservation) => void>();
      const manager = createOAuthManager({
        canRefreshCredential: async () => false,
        refreshCredential: async () => null,
        buildApiKey: async (_provider, value) => {
          formatted = value;
          return value.access;
        },
        readBootstrapCredential: () => null,
      });
      // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
      const post = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        if (request.type === "execute") {
          const command: unknown = deserialize(request.input);
          if (isRecord(command) && command.type === "authProfiles.personalAccept") {
            accepting = true;
            if (source === "formatter") {
              if (!formatted) {
                throw new Error("Acceptance started before credential formatting");
              }
              formatted.access = "synthetic-late-formatter-mutation";
            }
          }
        }
        return post.call(this, request, transferList);
      });
      const result = await withCanonicalAuthProfileCredentialObserver(observe, () =>
        manager.resolveOAuthAccess({
          profileId,
          credential: replacement,
          store: { version: 1, profiles: { [profileId]: replacement } },
          validateCredential: (current) => {
            if (source === "validator" && accepting && !mutationScheduled) {
              mutationScheduled = true;
              queueMicrotask(() => {
                current.access = "synthetic-late-validator-mutation";
              });
            }
          },
        }),
      );
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
      expect(result).toEqual({ apiKey: replacement.access, credential: replacement });
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0]?.[0].profiles[profileId]).toEqual(replacement);
    });
  },
);

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

it("publishes only the exact acknowledged personal postimage when its result frame is lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profileId, replacement } = fixture();
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
    } finally {
      await terminated;
    }
  });
});
