import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import * as directoryObservation from "../infra/owned-directory-observation.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readAuthProfileAuthorizationLifetime } from "./auth-profiles/authorization-lifetime.js";
import { retainAuthProfileAuthorizationObservation } from "./auth-profiles/authorization-observation.js";
import { captureAuthProfileAuthorization as captureAuth } from "./auth-profiles/authorization.js";
import { createOAuthManager } from "./auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "./auth-profiles/oauth-native-provider.test-support.js";
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
import { captureMcpAuthProfileAuthorization as captureMcp } from "./mcp-auth-profile-authorization.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
afterEach(() => vi.restoreAllMocks());
type AuthRoot = Awaited<ReturnType<typeof seedRoot>>;
type Authority = Awaited<ReturnType<typeof captureAuth>>;
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
    const authority = await (generic ? captureAuth : captureMcp)({
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
const writeProfile = (profileId: string, key: string, agentDir?: string) =>
  upsertAuthProfileWithLockOrThrow({ profileId, agentDir, credential: apiKey(key) });

it.each(["personal", "env-only", "bounded-store"] as const)(
  "rejects missing or unavailable %s authorization without substituting ambient credentials",
  async (scope) => {
    await withRoot(async (root) => {
      const capture = () =>
        captureAuth({
          profileId:
            scope === "personal"
              ? "personal:00000000-0000-4000-8000-000000000000:00000000-0000-4000-8000-000000000001"
              : "shared",
          agentDir: root.agentDir,
          assertCurrent: root.caller.assertCurrent,
        });
      await expect(
        scope === "env-only"
          ? withEnvOnlyAuthProfileStore(capture)
          : scope === "bounded-store"
            ? withAuthProfileStoreAgentDir(root.agentDir, root.stateDir, capture)
            : capture(),
      ).rejects.toMatchObject({
        code: scope === "personal" ? "MCP_AUTHORIZATION_RETIRED" : "MCP_AUTHORIZATION_UNAVAILABLE",
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
      await writeProfile(
        profileId,
        observation ? "original-local" : "original",
        observation ? root.agentDir : undefined,
      );
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
    mockOAuthProviderOperations({
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
    const manager = createOAuthManager();
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
      expect((await root.capture("fixture:oauth")).authorizationId).toBe(authority.authorizationId);
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
      using spy = vi.spyOn(admission, "createSqliteWorkerOperationAdmission");
      spy.mockImplementation((admit, attachment) => {
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
      await expect(
        writeProfile(profileId, "replacement", profileId === "local" ? root.agentDir : undefined),
      ).rejects.toThrow("fixture auth commit refused");
      expect(refused).toBe(true);
      expect(authority.assertCurrent).not.toThrow();
      await authority.revalidate();
    });
  },
);

it("enrolls an absent agent's inheritance tombstone through its native first-use owner", async () => {
  await withRoot(async (root) => {
    const agentDir = path.join(root.stateDir, "agents", "new-agent", "agent");
    const observe = directoryObservation.observeOwnedDirectory;
    using watcher = vi.spyOn(directoryObservation, "observeOwnedDirectory");
    watcher.mockImplementation((directory, onChange) =>
      // Native commit publication must not depend on a later filesystem notification.
      directory === agentDir ? { close() {} } : observe(directory, onChange),
    );
    const authority = await root.capture("shared", agentDir);
    expect(
      readAuthProfileAuthorizationLifetime(readPersistedAuthProfileStoreRaw(agentDir), "shared"),
    ).toEqual(expect.any(String));
    expect(authority.assertCurrent).not.toThrow();
    await writeProfile("shared", "override", agentDir);
    await expect(authority.revalidate()).rejects.toMatchObject(retiredCode);
  });
});

it.each([undefined, ""])(
  "retains access-only OAuth until expiry (refresh: %s)",
  async (refresh) => {
    await withRoot(async (root) => {
      const expires = Date.now() + 3_600_000;
      await persistAuthProfileBatch({
        profiles: [
          {
            profileId: "fixture:access-only",
            credential: {
              type: "oauth",
              provider: "fixture",
              access: "synthetic-access-only",
              ...(refresh === undefined ? {} : { refresh }),
              expires,
              // Persisted access-only input intentionally lacks the writer type's refresh field.
            } as OAuthCredential,
          },
        ],
      });
      const generic = await root.capture("fixture:access-only", root.agentDir, true);
      const mcp = await root.capture("fixture:access-only");
      expect(generic.authorizationId).toBe(mcp.authorizationId);
      expect(generic.assertCurrent).not.toThrow();
      expect(mcp.assertCurrent).not.toThrow();
      vi.spyOn(Date, "now").mockReturnValue(expires);
      expect(generic.assertCurrent).toThrow(retired);
      expect(mcp.assertCurrent).toThrow(retired);
      await expect(root.capture("fixture:access-only")).rejects.toMatchObject(retiredCode);
    });
  },
);
