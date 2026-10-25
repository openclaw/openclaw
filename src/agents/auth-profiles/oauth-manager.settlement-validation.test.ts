/** Tests credential validation during cross-agent OAuth settlement. */
import { describe, expect, it, vi } from "vitest";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../../infra/state-migrations.shared-auth-store.js";
import { resolveOpenAICodexAuthIdentity } from "../../plugin-sdk/provider-openai-chatgpt-auth.js";
import {
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./credential-observation.js";
import { expectTerminal, useOAuthCoordinationFixture } from "./oauth-coordination.test-support.js";
import { storeWith } from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } from "./persisted.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const fx = useOAuthCoordinationFixture();

function holdRefresh() {
  let result = (): OAuthCredential | undefined => undefined;
  const held = fx.blockRefresh(() => result());
  return {
    started: held.started,
    resolve: (credential: OAuthCredential) => {
      result = () => credential;
      held.finishRefresh();
    },
    reject: (error: unknown) => {
      result = () => {
        throw error;
      };
      held.finishRefresh();
    },
  };
}

function createWorkspaceAccessToken(accountId: string, rotation: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `e30.${payload}.${rotation}`;
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

describe("createOAuthManager settlement credential validation", () => {
  const profileId = "openai:default";
  const provider = "openai";
  const expiredStore = (rotation: string, options: Partial<OAuthCredential> = {}) =>
    storeWith(
      profileId,
      createWorkspaceCredential("workspace-a", rotation, {
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
        ...options,
      }),
    );
  const tokens = (accountId: string, rotation: string, refresh = `${rotation}-refresh`) => ({
    access: createWorkspaceAccessToken(accountId, rotation),
    refresh,
  });
  function createWorkspaceCredential(
    accountId: string,
    rotation: string,
    overrides: Partial<OAuthCredential> = {},
  ): OAuthCredential {
    return {
      type: "oauth",
      provider,
      ...tokens(accountId, rotation),
      expires: Date.now() + 60 * 60 * 1000,
      ...overrides,
    };
  }
  const resolve = (agentDir: string, validateOAuthCredential: (value: OAuthCredential) => void) =>
    fx.resolve(agentDir, profileId, { validateOAuthCredential });
  const publish = (value: OAuthCredential, agentDir?: string) =>
    persistAuthProfileBatch({
      agentDir,
      profiles: [{ profileId, credential: value }],
      resetFailureState: true,
      allowOAuthGenerationReplacement: true,
    });
  const readLocal = (agentDir: string) =>
    loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
  const readShared = () => loadPersistedSharedAuthProfileStore(process.env)?.profiles[profileId];
  function workspaceValidator(seen: Array<string | undefined>) {
    return (credential: { access: string }) => {
      const accountId = resolveOpenAICodexAuthIdentity({ access: credential.access }).accountId;
      seen.push(accountId);
      if (accountId !== "workspace-a") {
        throw new Error("credential owner mismatch");
      }
    };
  }
  async function createPeers(original: AuthProfileStore) {
    async function createPeer(index: number) {
      const agentDir = await fx.agentDirectory(`peer-${index}`);
      saveAuthProfileStore(original, agentDir);
      return agentDir;
    }
    return Promise.all([createPeer(0), createPeer(1)]);
  }

  async function startPeerRefresh() {
    const original = expiredStore("original", { email: "shared@example.test" });
    const peers = await createPeers(original);
    const refresh = holdRefresh();
    const validatedWorkspaceIds: Array<string | undefined> = [];
    const resolving = resolve(peers[0], workspaceValidator(validatedWorkspaceIds));
    await refresh.started;
    return { peers, refresh, validatedWorkspaceIds, resolving };
  }

  it.each([{ storage: "fresh" as const }, { storage: "upgraded" as const }])(
    "preserves an independent local rotation with $storage shared storage",
    async ({ storage }) => {
      const localAgentDir = await fx.agentDirectory("independent");
      const local = expiredStore("original", {
        accountId: "workspace-a",
        email: "same@example.test",
      });
      const shared = expiredStore("shared", {
        ...tokens("workspace-b", "shared", "workspace-b-refresh"),
        accountId: "workspace-b",
        email: "same@example.test",
        expires: Date.now() + 60 * 60 * 1000,
      });
      saveAuthProfileStore(local, localAgentDir);
      if (storage === "fresh") {
        saveAuthProfileStore(shared);
      } else {
        writePersistedAuthProfileStoreRaw(shared, fx.mainDir);
        const detected = detectSharedAuthStoreMigration({
          stateDir: fx.root,
          env: process.env,
          doctorOnlyStateMigrations: true,
        });
        expect(detected.hasLegacy).toBe(true);
        await migrateSharedAuthStore({ detected, stateDir: fx.root, env: process.env });
      }
      expect(loadPersistedAuthProfileStore(fx.mainDir)).toBeNull();

      fx.refresh.mockResolvedValue(
        createWorkspaceCredential("workspace-a", "rotated", {
          refresh: "workspace-a-rotated-refresh",
          accountId: "workspace-a",
        }),
      );
      const validatedWorkspaceIds: Array<string | undefined> = [];
      const observations: CanonicalAuthProfileCredentialObservation[] = [];
      const rotated = tokens("workspace-a", "rotated", "workspace-a-rotated-refresh");

      await expect(
        withCanonicalAuthProfileCredentialObserver(
          (value) => observations.push(value),
          () => resolve(localAgentDir, workspaceValidator(validatedWorkspaceIds)),
        ),
      ).resolves.toMatchObject({ apiKey: createWorkspaceAccessToken("workspace-a", "rotated") });

      expect(validatedWorkspaceIds).not.toContain("workspace-b");
      expect(observations).toContainEqual({
        databasePath: resolveAuthProfileDatabasePath(localAgentDir),
        profiles: {
          [profileId]: expect.objectContaining(rotated),
        },
      });
      expect(readLocal(localAgentDir)).toMatchObject(rotated);
      expect(readShared()).toMatchObject(tokens("workspace-b", "shared", "workspace-b-refresh"));
    },
  );

  it("keeps a newer same-account shared credential authoritative for historical peers", async () => {
    const [ownerAgentDir, peerAgentDir] = await Promise.all([
      fx.agentDirectory("owner"),
      fx.agentDirectory("peer"),
    ]);
    const local = expiredStore("original", { accountId: "workspace-a" });
    const olderShared = expiredStore("older-shared", {
      refresh: "older-shared-refresh",
      accountId: "workspace-a",
      expires: Date.now() - 120_000,
    });
    saveAuthProfileStore(local, ownerAgentDir);
    saveAuthProfileStore(local, peerAgentDir);
    saveAuthProfileStore(olderShared);

    const refresh = holdRefresh();
    const validatedRotations: string[] = [];
    const resolving = fx.resolve(ownerAgentDir, profileId, {
      validateOAuthCredential: (credential) => {
        const accountId = resolveOpenAICodexAuthIdentity({
          access: credential.access,
        }).accountId;
        if (accountId !== "workspace-a") {
          throw new Error("credential owner mismatch");
        }
        validatedRotations.push(credential.access);
      },
    });
    await refresh.started;
    const newerShared = createWorkspaceCredential("workspace-a", "newer-shared", {
      accountId: "workspace-a",
    });
    await publish(newerShared);
    refresh.resolve(
      createWorkspaceCredential("workspace-a", "local-rotation", {
        expires: Date.now() + 30 * 60 * 1000,
        accountId: "workspace-a",
      }),
    );

    await expect(resolving).resolves.toMatchObject({
      apiKey: createWorkspaceAccessToken("workspace-a", "local-rotation"),
    });
    expect(validatedRotations).toContain(createWorkspaceAccessToken("workspace-a", "newer-shared"));
    expect(readShared()).toEqual(newerShared);
    expect(readLocal(peerAgentDir)).toBeUndefined();
    expect(readLocal(ownerAgentDir)).toMatchObject(tokens("workspace-a", "local-rotation"));
  });

  it("preserves an upgraded local owner and fences its historical peer beside another account", async () => {
    const { peers, refresh, validatedWorkspaceIds, resolving } = await startPeerRefresh();
    await publish(
      createWorkspaceCredential("workspace-b", "relogin", {
        refresh: "relogin-other-workspace-refresh",
        expires: Date.now() + 10 * 60 * 1000,
        email: "shared@example.test",
      }),
      fx.mainDir,
    );
    refresh.resolve(
      createWorkspaceCredential("workspace-a", "stale-rotation", {
        email: "shared@example.test",
      }),
    );

    await expect(resolving).resolves.toMatchObject({
      apiKey: createWorkspaceAccessToken("workspace-a", "stale-rotation"),
    });
    expect(validatedWorkspaceIds.filter((accountId) => accountId === "workspace-b")).toHaveLength(
      1,
    );
    expect(readShared()).toMatchObject(
      tokens("workspace-b", "relogin", "relogin-other-workspace-refresh"),
    );
    expect(readLocal(peers[0])).toMatchObject(tokens("workspace-a", "stale-rotation"));
    const peer = readLocal(peers[1]);
    expectTerminal(peer);
    expect(peer).not.toMatchObject({
      access: createWorkspaceAccessToken("workspace-b", "relogin"),
    });
  });

  it("does not recover a conflicting owner after provider refresh failure", async () => {
    const { peers, refresh, validatedWorkspaceIds, resolving } = await startPeerRefresh();
    const conflictingOwner = createWorkspaceCredential("workspace-b", "relogin", {
      refresh: "relogin-other-workspace-refresh",
      email: "shared@example.test",
    });
    await publish(conflictingOwner, peers[0]);
    refresh.reject(new Error("provider refresh failed"));

    await expect(resolving).rejects.toThrow("credential owner mismatch");
    expect(validatedWorkspaceIds.filter((accountId) => accountId === "workspace-b")).toHaveLength(
      1,
    );
    expect(readLocal(peers[0])).toEqual(conflictingOwner);
    expectTerminal(readLocal(peers[1]));
  });
});
