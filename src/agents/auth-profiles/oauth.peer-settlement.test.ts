import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import {
  candidate,
  expired,
  expectTerminal,
  oauth,
  profileId,
  provider,
  read,
  requireOAuth,
  useOAuthCoordinationFixture,
} from "./oauth-coordination.test-support.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import {
  OAuthRefreshPeerFenceError,
  fenceOAuthRefreshPeers,
  rollbackOAuthRefreshPeerClaims,
  settleOAuthRefreshPeerClaims,
} from "./oauth-refresh-peers.js";
import { storeWith } from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { closeAuthProfileReadPool, resolveAuthProfileDatabasePath } from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import { captureAuthProfileStorePersistenceSnapshot } from "./store.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));
const fx = useOAuthCoordinationFixture();
async function seedAccountConflict(identifiedPeer = false) {
  const [ownerAgentDir, peerAgentDir] = await Promise.all([
    fx.agentDirectory("owner-a"),
    fx.agentDirectory("peer-a"),
  ]);
  const accountA = expired({ accountId: "acct-a" });
  saveAuthProfileStore(accountA, ownerAgentDir);
  saveAuthProfileStore(identifiedPeer ? accountA : expired(), peerAgentDir);
  saveAuthProfileStore(
    storeWith(profileId, oauth("shared-b", { accountId: "acct-b" })),
    fx.mainDir,
  );
  return { ownerAgentDir, peerAgentDir };
}
function retainPersistedCredential(agentDir: string, selectedProfileId: string) {
  const shared = openOpenClawStateDatabase();
  const { databasePath } = captureAuthProfileStorePersistenceSnapshot(agentDir).owner;
  const source = readDatabasePathIdentitySync(databasePath);
  const authority = captureAuthProfileCredentialAuthority(
    captureOpenClawStateWorkerContext({ path: shared.path }),
    { databasePath, identity: `${source.key}:${source.birthtime ?? ""}` },
    selectedProfileId,
  );
  authority.observe(loadPersistedAuthProfileStore(agentDir)?.profiles[selectedProfileId]);
  return authority;
}

describe("OAuth refresh peer settlement", () => {
  it("settles a replaced peer database discovered after provider refresh", async () => {
    const peerAgentDir = await fx.agentDirectory("peer-a");
    const original = expired({ accountId: "acct-a" });
    saveAuthProfileStore(original, peerAgentDir);
    const peerPath = resolveAuthProfileDatabasePath(peerAgentDir);
    const backupPath = path.join(fx.root, "peer-before-refresh.sqlite");
    closeAuthProfileReadPool({ kind: "database", databasePath: peerPath });
    await closeOpenClawAgentDatabaseByPathAsync(peerPath);
    await fs.copyFile(peerPath, backupPath);
    const originalIdentity = readDatabasePathIdentitySync(peerPath);
    saveAuthProfileStore(original, fx.mainDir);
    const replacement = oauth("rotated", { accountId: "acct-a" });
    fx.refresh.mockImplementation(async () => {
      const fenced = read(peerAgentDir);
      expect(fenced?.type === "oauth" && isPendingOAuthRefreshFence(fenced)).toBe(true);
      closeAuthProfileReadPool({ kind: "database", databasePath: peerPath });
      await closeOpenClawAgentDatabaseByPathAsync(peerPath);
      await fs.rename(backupPath, peerPath);
      expect(readDatabasePathIdentitySync(peerPath).key).not.toBe(originalIdentity.key);
      return replacement;
    });

    await expect(fx.resolve(fx.mainDir)).resolves.toMatchObject({ apiKey: replacement.access });
    expect(read(fx.mainDir)).toMatchObject(replacement);
    expect(read(peerAgentDir)).toBeUndefined();
    await expect(fx.resolve(peerAgentDir)).resolves.toMatchObject({ apiKey: replacement.access });
    expect(fx.refresh).toHaveBeenCalledOnce();
  });

  it("does not replace a different failed fence for the same refresh generation", async () => {
    const peerAgentDir = await fx.agentDirectory("peer-a");
    const original = requireOAuth(expired().profiles[profileId]);
    const ownerFence = createOAuthRefreshFence({ profileId, credential: original });
    const competingFence = createFailedOAuthRefreshFence(
      createOAuthRefreshFence({ profileId, credential: original }),
    );
    saveAuthProfileStore(storeWith(profileId, competingFence), peerAgentDir);

    await expect(
      fenceOAuthRefreshPeers({
        cfg: {},
        ownerDatabasePath: resolveAuthProfileDatabasePath(fx.mainDir),
        profileId,
        generation: original,
        fence: ownerFence,
      }),
    ).rejects.toThrow("already claimed");
    expect(read(peerAgentDir)).toEqual(competingFence);
  });

  it("retains a peer claim when its committed fence reply is lost", async () => {
    // OAuth fixtures reset the module registry before loading the auth runtime.
    const [workerPublications, { SqliteWorkerError }] = await Promise.all([
      import("../../state/openclaw-agent-worker-store.js"),
      import("../../infra/sqlite-worker-contract.js"),
    ]);
    const peerAgentDir = await fx.agentDirectory("peer-lost-reply");
    const store = expired();
    saveAuthProfileStore(store, peerAgentDir);
    const original = requireOAuth(read(peerAgentDir));
    const fence = createOAuthRefreshFence({ profileId, credential: original });
    const publish = workerPublications.executeOpenClawAgentWorkerPublication;
    const lostReply = vi
      .spyOn(workerPublications, "executeOpenClawAgentWorkerPublication")
      .mockImplementationOnce(async (...args) => {
        await publish(...args);
        throw new SqliteWorkerError("Synthetic lost peer acknowledgment", "outcome-unknown");
      });
    try {
      const failure = await fenceOAuthRefreshPeers({
        cfg: {},
        ownerDatabasePath: resolveAuthProfileDatabasePath(fx.mainDir),
        profileId,
        generation: original,
        fence,
        rollbackOnFailure: false,
      }).catch((error: unknown) => error);
      expect(lostReply).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(OAuthRefreshPeerFenceError);
      if (!(failure instanceof OAuthRefreshPeerFenceError)) {
        throw new Error("expected lost peer claim");
      }
      expect(failure.claims).toHaveLength(1);
      expect(read(peerAgentDir)).toStrictEqual(fence);
      await rollbackOAuthRefreshPeerClaims({ profileId, fence, claims: failure.claims });
      expect(read(peerAgentDir)).toStrictEqual(original);
      expect(lostReply).toHaveBeenCalledTimes(2);
    } finally {
      lostReply.mockRestore();
    }
  });

  it("terminally fences peers instead of exposing a different shared account", async () => {
    const { ownerAgentDir, peerAgentDir } = await seedAccountConflict();
    fx.refresh.mockResolvedValue(oauth("rotated-a", { accountId: "acct-a" }));

    await expect(fx.resolve(ownerAgentDir)).resolves.toMatchObject({ apiKey: "rotated-a-access" });

    expect(read(fx.mainDir)).toMatchObject({
      access: "shared-b-access",
      accountId: "acct-b",
    });
    expect(read(ownerAgentDir)).toMatchObject({
      access: "rotated-a-access",
      accountId: "acct-a",
    });
    const terminalPeer = read(peerAgentDir);
    expectTerminal(terminalPeer);
    await expect(fx.resolve(peerAgentDir)).resolves.toBeNull();
  });

  it.each([
    {
      name: "conflicting account ids despite matching email",
      provider: "openai",
      ownerIdentity: { accountId: "acct-a", email: "a@example.com" },
      peerIdentity: { accountId: "acct-b", email: "a@example.com" },
    },
    {
      name: "identity-less cross-tenant Copilot peer",
      provider: "github-copilot",
      ownerIdentity: { enterpriseUrl: "https://tenant-a.ghe.com/copilot/" },
      peerIdentity: { enterpriseUrl: "https://tenant-b.ghe.com/" },
    },
  ])(
    "terminally fences an exact replacement for $name",
    async ({ provider: peerProvider, ownerIdentity, peerIdentity }) => {
      const peerAgentDir = await fx.agentDirectory("peer-a");
      const peerProfileId = `${peerProvider}:default`;
      const ownerOriginal = oauth("cached", {
        provider: peerProvider,
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
        ...ownerIdentity,
      });
      const fence = createOAuthRefreshFence({
        profileId: peerProfileId,
        credential: ownerOriginal,
      });
      const replacement = {
        ...ownerOriginal,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
      };
      saveAuthProfileStore(storeWith(peerProfileId, fence), peerAgentDir);
      const persistedFence = requireOAuth(read(peerAgentDir, peerProfileId));
      await settleOAuthRefreshPeerClaims({
        profileId: peerProfileId,
        fence: persistedFence,
        claims: [
          {
            candidate: candidate("peer-a", peerAgentDir),
            original: { ...ownerOriginal, ...peerIdentity },
          },
        ],
        authoritativeSharedCredential: replacement,
        replacement,
      });
      const settled = read(peerAgentDir, peerProfileId);
      expectTerminal(settled);
    },
  );

  it("continues rolling back peers after one candidate cannot be restored or terminalized", async () => {
    const original = requireOAuth(expired().profiles[profileId]);
    const fence = createOAuthRefreshFence({ profileId, credential: original });
    const [brokenAgentDir, healthyAgentDir] = await Promise.all([
      fx.agentDirectory("peer-a"),
      fx.agentDirectory("peer-b"),
    ]);
    await fs.writeFile(resolveAuthProfileDatabasePath(brokenAgentDir), "not a sqlite database");
    saveAuthProfileStore(storeWith(profileId, fence), healthyAgentDir);
    const authority = retainPersistedCredential(healthyAgentDir, profileId);
    const persistedFence = requireOAuth(read(healthyAgentDir));

    await expect(
      rollbackOAuthRefreshPeerClaims({
        profileId,
        fence: persistedFence,
        claims: [
          {
            candidate: candidate("peer-b", healthyAgentDir),
            original,
          },
          {
            candidate: candidate("peer-a", brokenAgentDir),
            original,
          },
        ],
      }),
    ).rejects.toThrow(AggregateError);
    expect(authority.readCurrentCredential()).toEqual(read(healthyAgentDir));
    expect(read(healthyAgentDir)).toMatchObject({
      type: "oauth",
      provider,
      access: original.access,
      refresh: original.refresh,
      expires: original.expires,
    });
  });

  it("terminally fences superseded peers when shared inheritance is a different account", async () => {
    const { ownerAgentDir, peerAgentDir } = await seedAccountConflict(true);

    const { started, finishRefresh } = fx.blockRefresh(() => undefined);

    const resolving = fx.resolve(ownerAgentDir);
    await started;
    await fx.reconnect(ownerAgentDir, oauth("relogin-a", { accountId: "acct-a" }));
    finishRefresh();

    await expect(resolving).resolves.toMatchObject({ apiKey: "relogin-a-access" });
    expect(read(fx.mainDir)).toMatchObject({
      access: "shared-b-access",
      accountId: "acct-b",
    });
    const terminalPeer = read(peerAgentDir);
    expectTerminal(terminalPeer);
  });

  it("reports exact removal owners and preserves a reconnected peer", async () => {
    const [peerAgentDir, otherAgentDir] = await Promise.all([
      fx.agentDirectory("peer-a"),
      fx.agentDirectory("other"),
    ]);
    const original = expired({ accountId: "acct-a" });
    const replacement = expired({
      access: "independent-access",
      refresh: "independent-refresh",
      accountId: "acct-b",
    });
    // Create the historical copy first; a save after the shared owner exists is inherited.
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, fx.mainDir);
    saveAuthProfileStore(replacement, otherAgentDir);
    const ownerAuthority = retainPersistedCredential(fx.mainDir, profileId);
    const peerAuthority = retainPersistedCredential(peerAgentDir, profileId);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);
    const peerScope = {
      agentDir: peerAgentDir,
      databasePath: resolveAuthProfileDatabasePath(peerAgentDir),
      profileIds: [profileId],
    };
    const beforeRemove = vi.fn(async () => {
      await persistAuthProfileBatch({
        agentDir: peerAgentDir,
        profiles: [{ profileId, credential: replacement.profiles[profileId]! }],
        allowOAuthGenerationReplacement: true,
      });
    });
    const onIncomplete = vi.fn(async () => {});

    await expect(
      removeAuthProfilesAcrossOwnerStores({
        agentDir: fx.mainDir,
        profileIds: [profileId],
        beforeRemove,
        onIncomplete,
      }),
    ).resolves.toBe(true);

    expect(beforeRemove).toHaveBeenCalledExactlyOnceWith(
      [profileId],
      [
        {
          agentDir: undefined,
          databasePath: resolveAuthProfileDatabasePath(fx.mainDir),
          profileIds: [profileId],
        },
        peerScope,
      ],
    );
    expect(ownerAuthority.readCurrentCredential()).toBeUndefined();
    expect(peerAuthority.readCurrentCredential()).toEqual(replacement.profiles[profileId]);
    expect(read(fx.mainDir)).toBeUndefined();
    expect(read(peerAgentDir)).toEqual(replacement.profiles[profileId]);
    expect(read(otherAgentDir)).toEqual(replacement.profiles[profileId]);
    expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
      new Map([[profileId, replacement.profiles[profileId]]]),
      [peerScope],
    );
  });

  it("does not republish a refresh generation removed during provider I/O", async () => {
    const peerAgentDir = await fx.agentDirectory("peer-a");

    const original = expired({ accountId: "acct-a" });
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, fx.mainDir);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);

    const { started, finishRefresh } = fx.blockRefresh(() =>
      oauth("late-rotated", { accountId: "acct-a" }),
    );

    const resolving = fx.resolve(peerAgentDir);
    await started;
    await removeAuthProfilesAcrossOwnerStores({
      profileIds: [profileId],
      agentDir: fx.mainDir,
    });
    finishRefresh();

    await expect(resolving).rejects.toThrow("Failed to persist refreshed OAuth credential");
    expect(read(fx.mainDir)).toBeUndefined();
    expect(read(peerAgentDir)).toBeUndefined();
  });
});
