import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import * as directoryObservation from "../infra/owned-directory-observation.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readAuthProfileAuthorizationLifetime } from "./auth-profiles/authorization-lifetime.js";
import { retainAuthProfileAuthorizationObservation } from "./auth-profiles/authorization-observation.js";
import { captureAuthProfileAuthorization } from "./auth-profiles/authorization.js";
import { createOAuthManager } from "./auth-profiles/oauth-manager.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  upsertAuthProfileWithLockOrThrow,
} from "./auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { readPersistedAuthProfileStoreRaw } from "./auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "./auth-profiles/store-runtime.js";
import { createAuthOwnerTestFixtures } from "./auth-profiles/store-state-owner.test-support.js";
import {
  withAuthProfileStoreAgentDir,
  withEnvOnlyAuthProfileStore,
} from "./auth-profiles/store.js";
import type { OAuthCredential } from "./auth-profiles/types.js";
import { persistAuthProfileBatch } from "./auth-profiles/upsert-with-lock.js";
import { captureMcpAuthProfileAuthorization } from "./mcp-auth-profile-authorization.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
type AuthRoot = Awaited<ReturnType<typeof seedRoot>>;
type Authority = Awaited<ReturnType<typeof captureAuthProfileAuthorization>>;
type AuthFixture = AuthRoot & {
  caller: ReturnType<typeof source>;
  capture: (profileId?: string, agentDir?: string, generic?: boolean) => Promise<Authority>;
};
async function withRoot(run: (root: AuthFixture) => Promise<void>) {
  const root = await seedRoot("original");
  const caller = source();
  const handles: Authority[] = [];
  const capture: AuthFixture["capture"] = async (
    profileId = "shared",
    agentDir = root.agentDir,
    generic = false,
  ) => {
    const authority = await (
      generic ? captureAuthProfileAuthorization : captureMcpAuthProfileAuthorization
    )({
      profileId,
      agentDir,
      assertCurrent: caller.assertCurrent,
    });
    handles.push(authority);
    return authority;
  };
  await withEnvAsync(root.env, async () => {
    try {
      await run({ ...root, caller, capture });
    } finally {
      for (const handle of handles.toReversed()) {
        handle.dispose();
      }
    }
  });
}
const retired = expect.objectContaining({ code: "MCP_AUTHORIZATION_RETIRED" });
const retiredCode = { code: "MCP_AUTHORIZATION_RETIRED" };
const unavailableCode = { code: "MCP_AUTHORIZATION_UNAVAILABLE" };
function source() {
  let active = true;
  return {
    assertCurrent(this: void) {
      if (!active) {
        throw new Error("source retired");
      }
    },
    retire() {
      active = false;
    },
  };
}

async function foreign(root: AuthRoot, script: string) {
  const result = await runNodeScript(
    ["--import", "tsx", "--input-type=module", "-e", script],
    root.env,
    30_000,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
const captureUrl = new URL("./mcp-auth-profile-authorization.ts", import.meta.url).href;

describe("auth-profile authorization", () => {
  it.each(["personal", "env-only", "bounded-store"] as const)(
    "rejects missing or unavailable %s authorization without substituting ambient credentials",
    async (scope) => {
      await withRoot(async (root) => {
        const capture = () =>
          captureAuthProfileAuthorization({
            profileId:
              scope === "personal"
                ? "personal:00000000-0000-4000-8000-000000000000:00000000-0000-4000-8000-000000000001"
                : "shared",
            agentDir: root.agentDir,
            assertCurrent: source().assertCurrent,
          });
        await expect(
          scope === "env-only"
            ? withEnvOnlyAuthProfileStore(capture)
            : scope === "bounded-store"
              ? withAuthProfileStoreAgentDir(root.agentDir, root.stateDir, capture)
              : capture(),
        ).rejects.toMatchObject({
          code:
            scope === "personal" ? "MCP_AUTHORIZATION_RETIRED" : "MCP_AUTHORIZATION_UNAVAILABLE",
        });
      });
    },
  );

  it("enrolls inherited owners through the generic API and preserves MCP capture across processes", async () => {
    await withRoot(async (root) => {
      const authority = await root.capture("shared", root.agentDir, true);
      const id = authority.authorizationId;
      expect(id).not.toContain("original");
      await updateAuthProfileStoreWithLock({
        updater(store) {
          store.usageStats = { shared: { lastUsed: Date.now(), errorCount: 0 } };
          return true;
        },
      });
      await authority.revalidate();
      expect(authority.assertCurrent).not.toThrow();
      clearRuntimeAuthProfileStoreSnapshots();
      const output = await foreign(
        root,
        "import { captureMcpAuthProfileAuthorization as capture } from " +
          JSON.stringify(captureUrl) +
          ";" +
          "let active = true; const authority = await capture({ profileId: 'shared', agentDir: " +
          JSON.stringify(root.agentDir) +
          ", assertCurrent() { if (!active) throw new Error('source retired'); } });" +
          "console.log(authority.authorizationId); active = false; authority.dispose();",
      );
      expect(output).toContain(id);
      root.caller.retire();
      expect(authority.assertCurrent).toThrow(retired);
      authority.dispose();
      await expect(authority.revalidate()).rejects.toMatchObject(retiredCode);
    });
  });

  it.each(["reconnect", "replace"] as const)("retires identical-byte %s", async (mode) => {
    await withRoot(async (root) => {
      const profileId = mode === "reconnect" ? "shared" : "local";
      const authority = await root.capture(profileId);
      const observation =
        mode === "replace"
          ? retainAuthProfileAuthorizationObservation(root.agentPath, profileId)
          : undefined;
      try {
        const raw = observation && readPersistedAuthProfileStoreRaw(root.agentDir);
        const publish = observation?.prepareRead();
        if (mode === "reconnect") {
          expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: [profileId] })).toBe(true);
        }
        await upsertAuthProfileWithLockOrThrow({
          profileId,
          agentDir: observation ? root.agentDir : undefined,
          credential: apiKey(observation ? "original-local" : "original"),
        });
        if (publish) {
          expect(() => publish(raw)).toThrow(expect.objectContaining(unavailableCode));
        }
        expect(authority.assertCurrent).toThrow(retired);
        if (mode === "reconnect") {
          await expect(authority.revalidate()).rejects.toMatchObject(retiredCode);
          expect((await root.capture()).authorizationId).not.toBe(authority.authorizationId);
        }
      } finally {
        observation?.dispose();
      }
    });
  });

  it("keeps the same lifetime through the real refresh owner's claim and settlement", async () => {
    await withRoot(async (root) => {
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "fixture",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1,
        accountId: "fixture-account",
      };
      await persistAuthProfileBatch({ profiles: [{ profileId: "fixture:oauth", credential }] });
      const authority = await root.capture("fixture:oauth", root.agentDir, true);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const manager = createOAuthManager({
        buildApiKey: async (_provider, value) => value.access,
        canRefreshCredential: async () => true,
        readBootstrapCredential: () => null,
        refreshCredential: async () => {
          entered.resolve();
          await release.promise;
          return {
            access: "new-access",
            refresh: "new-refresh",
            expires: Date.now() + 600_000,
            accountId: "fixture-account",
          };
        },
      });
      const refresh = manager.resolveOAuthAccess({
        store: loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
        profileId: "fixture:oauth",
        credential,
        agentDir: root.agentDir,
      });
      try {
        await entered.promise;
        await expect(authority.revalidate()).rejects.toMatchObject(unavailableCode);
        release.resolve();
        await expect(refresh).resolves.toMatchObject({ apiKey: "new-access" });
        await authority.revalidate();
        expect(authority.assertCurrent).not.toThrow();
        const recaptured = await root.capture("fixture:oauth");
        expect(recaptured.authorizationId).toBe(authority.authorizationId);
      } finally {
        release.resolve();
        await refresh;
      }
    });
  });

  it.each(["local", "shared"])(
    "fences %s worker commit admission and restores authorization on rollback",
    async (profileId) => {
      await withRoot(async (root) => {
        const authority = await root.capture(profileId);
        const createAdmission = admission.createSqliteWorkerOperationAdmission;
        let refused = false;
        const spy = vi
          .spyOn(admission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) => {
            let updating = false;
            return createAdmission((request, grant) => {
              updating ||= isRecord(request.facts) && request.facts.kind === "auth-store-update";
              if (updating && request.stage === "commit") {
                admit(request, () => {
                  expect(authority.assertCurrent).toThrow(expect.objectContaining(unavailableCode));
                  refused = true;
                  throw new Error("fixture auth commit refused");
                });
              } else {
                admit(request, grant);
              }
            }, attachment);
          });
        try {
          await expect(
            upsertAuthProfileWithLockOrThrow({
              profileId,
              agentDir: profileId === "local" ? root.agentDir : undefined,
              credential: apiKey("replacement"),
            }),
          ).rejects.toThrow("fixture auth commit refused");
          expect(refused).toBe(true);
          expect(authority.assertCurrent).not.toThrow();
          await authority.revalidate();
        } finally {
          spy.mockRestore();
        }
      });
    },
  );

  it("enrolls an absent agent's inheritance tombstone through its native first-use owner", async () => {
    await withRoot(async (root) => {
      const agentDir = path.join(root.stateDir, "agents", "new-agent", "agent");
      const observe = directoryObservation.observeOwnedDirectory;
      const watcher = vi
        .spyOn(directoryObservation, "observeOwnedDirectory")
        .mockImplementation((directory, onChange, options) =>
          // Native commit publication must not depend on a later filesystem notification.
          directory === agentDir ? { close() {} } : observe(directory, onChange, options),
        );
      try {
        const authority = await root.capture("shared", agentDir);
        expect(
          readAuthProfileAuthorizationLifetime(
            readPersistedAuthProfileStoreRaw(agentDir),
            "shared",
          ),
        ).toEqual(expect.any(String));
        expect(authority.assertCurrent).not.toThrow();
        await upsertAuthProfileWithLockOrThrow({
          profileId: "shared",
          agentDir,
          credential: apiKey("override"),
        });
        await expect(authority.revalidate()).rejects.toMatchObject(retiredCode);
      } finally {
        watcher.mockRestore();
      }
    });
  });
});
