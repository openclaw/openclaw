import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { retainAuthProfileAuthorizationObservation } from "./auth-profiles/authorization-observation.js";
import { createOAuthManager } from "./auth-profiles/oauth-manager.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  upsertAuthProfileWithLockOrThrow,
} from "./auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "./auth-profiles/sqlite-read.js";
import { readPersistedAuthProfileStoreRaw } from "./auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "./auth-profiles/store-runtime.js";
import { createAuthOwnerTestFixtures } from "./auth-profiles/store-state-owner.test-support.js";
import type { OAuthCredential } from "./auth-profiles/types.js";
import { persistAuthProfileBatch } from "./auth-profiles/upsert-with-lock.js";
import { captureMcpAuthProfileAuthorization } from "./mcp-auth-profile-authorization.js";

const { seedRoot, apiKey } = createAuthOwnerTestFixtures();
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

async function foreign(root: Awaited<ReturnType<typeof seedRoot>>, script: string) {
  const result = await runNodeScript(
    ["--import", "tsx", "--input-type=module", "-e", script],
    root.env,
    30_000,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
const runtimeUrl = new URL("./auth-profiles/store-runtime.ts", import.meta.url).href;
const captureUrl = new URL("./mcp-auth-profile-authorization.ts", import.meta.url).href;

describe("MCP auth-profile authorization", () => {
  it("enrolls actual inherited owners, survives usage and fresh process capture, and fences disposal", async () => {
    const root = await seedRoot("original");
    await withEnvAsync(root.env, async () => {
      const caller = source();
      const authority = await captureMcpAuthProfileAuthorization({
        profileId: "shared",
        agentDir: root.agentDir,
        assertCurrent: caller.assertCurrent,
      });
      try {
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
        caller.retire();
        expect(authority.assertCurrent).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_RETIRED" }),
        );
      } finally {
        authority.dispose();
      }
      await expect(authority.revalidate()).rejects.toMatchObject({
        code: "MCP_AUTHORIZATION_RETIRED",
      });
    });
  });

  it("does not revive an old handle after remove and same-byte reconnect", async () => {
    const root = await seedRoot("original");
    await withEnvAsync(root.env, async () => {
      const caller = source();
      const old = await captureMcpAuthProfileAuthorization({
        profileId: "shared",
        agentDir: root.agentDir,
        assertCurrent: caller.assertCurrent,
      });
      try {
        expect(await removeAuthProfilesAcrossOwnerStores({ profileIds: ["shared"] })).toBe(true);
        await upsertAuthProfileWithLockOrThrow({
          profileId: "shared",
          credential: apiKey("original"),
        });
        expect(old.assertCurrent).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_RETIRED" }),
        );
        await expect(old.revalidate()).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_RETIRED" });
        const replacement = await captureMcpAuthProfileAuthorization({
          profileId: "shared",
          agentDir: root.agentDir,
          assertCurrent: caller.assertCurrent,
        });
        try {
          expect(replacement.authorizationId).not.toBe(old.authorizationId);
        } finally {
          replacement.dispose();
        }
      } finally {
        old.dispose();
      }
    });
  });

  it("retires identical-byte replacement and rejects its stale observation without removal", async () => {
    const root = await seedRoot("same-key");
    await withEnvAsync(root.env, async () => {
      const caller = source();
      const authority = await captureMcpAuthProfileAuthorization({
        profileId: "local",
        agentDir: root.agentDir,
        assertCurrent: caller.assertCurrent,
      });
      const observation = retainAuthProfileAuthorizationObservation(root.agentPath, "local");
      try {
        const raw = readPersistedAuthProfileStoreRaw(root.agentDir);
        const publish = observation.prepareRead();
        await upsertAuthProfileWithLockOrThrow({
          profileId: "local",
          agentDir: root.agentDir,
          credential: apiKey("same-key-local"),
        });
        expect(() => publish(raw)).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }),
        );
        expect(authority.assertCurrent).toThrow(
          expect.objectContaining({ code: "MCP_AUTHORIZATION_RETIRED" }),
        );
      } finally {
        observation.dispose();
        authority.dispose();
      }
    });
  });

  it.each(["override", "remove-readd"])(
    "observes foreign %s ABA even when the effective credential ends unchanged",
    async (operation) => {
      const root = await seedRoot("original");
      await withEnvAsync(root.env, async () => {
        const caller = source();
        const authority = await captureMcpAuthProfileAuthorization({
          profileId: "shared",
          agentDir: root.agentDir,
          assertCurrent: caller.assertCurrent,
        });
        try {
          const target = operation === "override" ? JSON.stringify(root.agentDir) : "undefined";
          const script =
            "import { updateAuthProfileStoreWithLock as update } from " +
            JSON.stringify(runtimeUrl) +
            ";" +
            "await update({agentDir: " +
            target +
            ", updater(store) { " +
            (operation === "override"
              ? "store.profiles.shared = {type:'api_key',provider:'openai',key:'local-shadow'};"
              : "delete store.profiles.shared;") +
            " return true; }});" +
            "await update({agentDir: " +
            target +
            ", updater(store) { " +
            (operation === "override"
              ? "delete store.profiles.shared;"
              : "store.profiles.shared = {type:'api_key',provider:'openai',key:'original'};") +
            " return true; }});";
          await foreign(root, script);
          // Fresh canonical reads, not the process-local mutation maps, detect the changed incarnation.
          await expect(authority.revalidate()).rejects.toMatchObject({
            code: "MCP_AUTHORIZATION_RETIRED",
          });
        } finally {
          authority.dispose();
        }
      });
    },
  );

  it("keeps the same lifetime through the real refresh owner's claim and settlement", async () => {
    const root = await seedRoot("unrelated");
    await withEnvAsync(root.env, async () => {
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "fixture",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1,
        accountId: "fixture-account",
      };
      await persistAuthProfileBatch({ profiles: [{ profileId: "fixture:oauth", credential }] });
      const caller = source();
      const authority = await captureMcpAuthProfileAuthorization({
        profileId: "fixture:oauth",
        agentDir: root.agentDir,
        assertCurrent: caller.assertCurrent,
      });
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
        await expect(authority.revalidate()).rejects.toMatchObject({
          code: "MCP_AUTHORIZATION_UNAVAILABLE",
        });
        release.resolve();
        await expect(refresh).resolves.toMatchObject({ apiKey: "new-access" });
        await authority.revalidate();
        expect(authority.assertCurrent).not.toThrow();
        const recaptured = await captureMcpAuthProfileAuthorization({
          profileId: "fixture:oauth",
          agentDir: root.agentDir,
          assertCurrent: caller.assertCurrent,
        });
        try {
          expect(recaptured.authorizationId).toBe(authority.authorizationId);
        } finally {
          recaptured.dispose();
        }
      } finally {
        release.resolve();
        await refresh;
        authority.dispose();
      }
    });
  });

  it.each(["local", "shared"])(
    "fences %s worker commit admission and restores authorization on rollback",
    async (profileId) => {
      const root = await seedRoot("rollback");
      await withEnvAsync(root.env, async () => {
        const authority = await captureMcpAuthProfileAuthorization({
          profileId,
          agentDir: root.agentDir,
          assertCurrent: source().assertCurrent,
        });
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
                  expect(authority.assertCurrent).toThrow(
                    expect.objectContaining({ code: "MCP_AUTHORIZATION_UNAVAILABLE" }),
                  );
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
          authority.dispose();
        }
      });
    },
  );

  it("cannot publish delayed canonical facts after disposal", async () => {
    const root = await seedRoot("inherited");
    await withEnvAsync(root.env, async () => {
      const caller = source();
      const authority = await captureMcpAuthProfileAuthorization({
        profileId: "shared",
        agentDir: root.agentDir,
        assertCurrent: caller.assertCurrent,
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const read = sqliteRead.readSharedAuthProfileRows;
      const spy = vi
        .spyOn(sqliteRead, "readSharedAuthProfileRows")
        .mockImplementation(async (...args) => {
          const rows = await read(...args);
          entered.resolve();
          await release.promise;
          return rows;
        });
      const pending = authority.revalidate();
      const refused = expect(pending).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_RETIRED" });
      try {
        await entered.promise;
        authority.dispose();
        release.resolve();
        await refused;
      } finally {
        release.resolve();
        spy.mockRestore();
        authority.dispose();
      }
    });
  });

  it("enrolls an absent agent's inheritance tombstone through its native first-use owner", async () => {
    const root = await seedRoot("inherited");
    await withEnvAsync(root.env, async () => {
      const caller = source();
      const agentDir = path.join(root.stateDir, "agents", "new-agent", "agent");
      const authority = await captureMcpAuthProfileAuthorization({
        profileId: "shared",
        agentDir,
        assertCurrent: caller.assertCurrent,
      });
      try {
        await upsertAuthProfileWithLockOrThrow({
          profileId: "shared",
          agentDir,
          credential: apiKey("override"),
        });
        await expect(authority.revalidate()).rejects.toMatchObject({
          code: "MCP_AUTHORIZATION_RETIRED",
        });
      } finally {
        authority.dispose();
      }
    });
  });
});
