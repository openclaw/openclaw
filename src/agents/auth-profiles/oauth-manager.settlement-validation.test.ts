/** Tests credential validation during cross-agent OAuth settlement. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import {
  detectSharedAuthStoreMigration,
  migrateSharedAuthStore,
} from "../../infra/state-migrations.shared-auth-store.js";
import { resolveOpenAICodexAuthIdentity } from "../../plugin-sdk/provider-openai-chatgpt-auth.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

function createWorkspaceAccessToken(accountId: string, rotation: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `e30.${payload}.${rotation}`;
}

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.test-support.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  ({ resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js"));
  resetOAuthRefreshQueuesForTest();
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

describe("createOAuthManager settlement credential validation", () => {
  it.each([{ storage: "fresh" as const }, { storage: "upgraded" as const }])(
    "preserves an independent local rotation with $storage shared storage",
    async ({ storage }) => {
      const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
      let tempRoot = "";

      try {
        resetFileLockStateForTest();
        resetOAuthProviderRuntimeMocks({
          refreshProviderOAuthCredentialWithPluginMock,
          formatProviderAuthProfileApiKeyWithPluginMock,
        });
        clearRuntimeAuthProfileStoreSnapshots();
        tempRoot = await createOAuthTestTempRoot("openclaw-oauth-independent-validator-");
        const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
        await loadOAuthModuleForTest();
        const profileId = "openai:default";
        const provider = "openai";
        const localAgentDir = path.join(tempRoot, "agents", "independent", "agent");
        await fs.mkdir(localAgentDir, { recursive: true });
        const local = createExpiredOauthStore({
          profileId,
          provider,
          access: createWorkspaceAccessToken("workspace-a", "original"),
          accountId: "workspace-a",
          email: "same@example.test",
        });
        const shared = createExpiredOauthStore({
          profileId,
          provider,
          access: createWorkspaceAccessToken("workspace-b", "shared"),
          accountId: "workspace-b",
          email: "same@example.test",
        });
        const sharedCredential = shared.profiles[profileId];
        if (sharedCredential?.type !== "oauth") {
          throw new Error("expected shared OAuth credential");
        }
        sharedCredential.refresh = "workspace-b-refresh";
        sharedCredential.expires = Date.now() + 60 * 60 * 1000;
        saveAuthProfileStore(local, localAgentDir);
        if (storage === "fresh") {
          saveAuthProfileStore(shared);
        } else {
          writePersistedAuthProfileStoreRaw(shared, mainAgentDir);
          const detected = detectSharedAuthStoreMigration({
            stateDir: tempRoot,
            env: process.env,
            doctorOnlyStateMigrations: true,
          });
          expect(detected.hasLegacy).toBe(true);
          await migrateSharedAuthStore({ detected, stateDir: tempRoot, env: process.env });
        }
        expect(loadPersistedAuthProfileStore(mainAgentDir)).toBeNull();

        refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
          type: "oauth",
          provider,
          access: createWorkspaceAccessToken("workspace-a", "rotated"),
          refresh: "workspace-a-rotated-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "workspace-a",
        } as never);
        const validatedWorkspaceIds: Array<string | undefined> = [];

        await expect(
          resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
            store: ensureAuthProfileStore(localAgentDir),
            profileId,
            agentDir: localAgentDir,
            validateOAuthCredential: (credential) => {
              const accountId = resolveOpenAICodexAuthIdentity({
                access: credential.access,
              }).accountId;
              validatedWorkspaceIds.push(accountId);
              if (accountId !== "workspace-a") {
                throw new Error("credential owner mismatch");
              }
            },
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            apiKey: createWorkspaceAccessToken("workspace-a", "rotated"),
          }),
        );

        expect(
          validatedWorkspaceIds.filter((accountId) => accountId === "workspace-b"),
        ).toHaveLength(0);
        expect(loadPersistedAuthProfileStore(localAgentDir)?.profiles[profileId]).toMatchObject({
          access: createWorkspaceAccessToken("workspace-a", "rotated"),
          refresh: "workspace-a-rotated-refresh",
        });
        expect(loadPersistedSharedAuthProfileStore(process.env)?.profiles[profileId]).toMatchObject(
          {
            access: createWorkspaceAccessToken("workspace-b", "shared"),
            refresh: "workspace-b-refresh",
          },
        );
      } finally {
        envSnapshot.restore();
        resetFileLockStateForTest();
        clearRuntimeAuthProfileStoreSnapshots();
        await removeOAuthTestTempRoot(tempRoot);
      }
    },
  );

  it("keeps a newer same-account shared credential authoritative for historical peers", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-newer-shared-validator-");
      await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const ownerAgentDir = path.join(tempRoot, "agents", "owner", "agent");
      const peerAgentDir = path.join(tempRoot, "agents", "peer", "agent");
      await Promise.all([
        fs.mkdir(ownerAgentDir, { recursive: true }),
        fs.mkdir(peerAgentDir, { recursive: true }),
      ]);
      const local = createExpiredOauthStore({
        profileId,
        provider,
        access: createWorkspaceAccessToken("workspace-a", "original"),
        accountId: "workspace-a",
      });
      const olderShared = createExpiredOauthStore({
        profileId,
        provider,
        access: createWorkspaceAccessToken("workspace-a", "older-shared"),
        refresh: "older-shared-refresh",
        accountId: "workspace-a",
      });
      const olderSharedCredential = olderShared.profiles[profileId];
      if (olderSharedCredential?.type !== "oauth") {
        throw new Error("expected shared OAuth credential");
      }
      olderSharedCredential.expires = Date.now() - 120_000;
      saveAuthProfileStore(local, ownerAgentDir);
      saveAuthProfileStore(local, peerAgentDir);
      saveAuthProfileStore(olderShared);

      let finishRefresh: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return {
          type: "oauth",
          provider,
          access: createWorkspaceAccessToken("workspace-a", "local-rotation"),
          refresh: "local-rotation-refresh",
          expires: Date.now() + 30 * 60 * 1000,
          accountId: "workspace-a",
        } as never;
      });
      const validatedRotations: string[] = [];
      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(ownerAgentDir),
        profileId,
        agentDir: ownerAgentDir,
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
      await started;
      const newerShared = {
        type: "oauth" as const,
        provider,
        access: createWorkspaceAccessToken("workspace-a", "newer-shared"),
        refresh: "newer-shared-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "workspace-a",
      };
      await persistAuthProfileBatch({
        profiles: [{ profileId, credential: newerShared }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      finishRefresh?.();

      await expect(resolving).resolves.toEqual(
        expect.objectContaining({
          apiKey: createWorkspaceAccessToken("workspace-a", "local-rotation"),
        }),
      );
      expect(validatedRotations).toContain(
        createWorkspaceAccessToken("workspace-a", "newer-shared"),
      );
      expect(loadPersistedSharedAuthProfileStore(process.env)?.profiles[profileId]).toEqual(
        newerShared,
      );
      expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId]).toBeUndefined();
      expect(loadPersistedAuthProfileStore(ownerAgentDir)?.profiles[profileId]).toMatchObject({
        access: createWorkspaceAccessToken("workspace-a", "local-rotation"),
        refresh: "local-rotation-refresh",
      });
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("preserves an upgraded local owner and fences its historical peer beside another account", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-relogin-validator-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const original = createExpiredOauthStore({
        profileId,
        provider,
        access: createWorkspaceAccessToken("workspace-a", "original"),
        email: "shared@example.test",
      });
      const peers = await Promise.all(
        Array.from({ length: 2 }, async (_, index) => {
          const agentDir = path.join(tempRoot, "agents", `peer-${index}`, "agent");
          await fs.mkdir(agentDir, { recursive: true });
          saveAuthProfileStore(original, agentDir);
          return agentDir;
        }),
      );

      let finishRefresh: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return {
          type: "oauth",
          provider,
          access: createWorkspaceAccessToken("workspace-a", "stale-rotation"),
          refresh: "stale-rotation-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          email: "shared@example.test",
        } as never;
      });

      const validatedWorkspaceIds: Array<string | undefined> = [];
      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(peers[0]),
        profileId,
        agentDir: peers[0],
        validateOAuthCredential: (credential) => {
          const accountId = resolveOpenAICodexAuthIdentity({
            access: credential.access,
          }).accountId;
          validatedWorkspaceIds.push(accountId);
          if (accountId !== "workspace-a") {
            throw new Error("credential owner mismatch");
          }
        },
      });
      await started;
      await persistAuthProfileBatch({
        agentDir: mainAgentDir,
        profiles: [
          {
            profileId,
            credential: {
              type: "oauth",
              provider,
              access: createWorkspaceAccessToken("workspace-b", "relogin"),
              refresh: "relogin-other-workspace-refresh",
              expires: Date.now() + 10 * 60 * 1000,
              email: "shared@example.test",
            },
          },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      finishRefresh?.();

      await expect(resolving).resolves.toEqual(
        expect.objectContaining({
          apiKey: createWorkspaceAccessToken("workspace-a", "stale-rotation"),
        }),
      );
      expect(validatedWorkspaceIds.filter((accountId) => accountId === "workspace-b")).toHaveLength(
        1,
      );
      expect(loadPersistedSharedAuthProfileStore(process.env)?.profiles[profileId]).toMatchObject({
        access: createWorkspaceAccessToken("workspace-b", "relogin"),
        refresh: "relogin-other-workspace-refresh",
      });
      expect(loadPersistedAuthProfileStore(peers[0])?.profiles[profileId]).toMatchObject({
        access: createWorkspaceAccessToken("workspace-a", "stale-rotation"),
        refresh: "stale-rotation-refresh",
      });
      const peer = loadPersistedAuthProfileStore(peers[1])?.profiles[profileId];
      expect(peer?.type === "oauth" && isOAuthRefreshFence(peer)).toBe(true);
      expect(peer?.type === "oauth" && isPendingOAuthRefreshFence(peer)).toBe(false);
      expect(peer).not.toMatchObject({
        access: createWorkspaceAccessToken("workspace-b", "relogin"),
      });
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("does not recover a conflicting owner after provider refresh failure", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-failed-relogin-validator-");
      await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const original = createExpiredOauthStore({
        profileId,
        provider,
        access: createWorkspaceAccessToken("workspace-a", "original"),
        email: "shared@example.test",
      });
      const peers = await Promise.all(
        Array.from({ length: 2 }, async (_, index) => {
          const agentDir = path.join(tempRoot, "agents", `peer-${index}`, "agent");
          await fs.mkdir(agentDir, { recursive: true });
          saveAuthProfileStore(original, agentDir);
          return agentDir;
        }),
      );

      let rejectRefresh: ((error: Error) => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
        markStarted?.();
        return await new Promise<never>((_, reject) => {
          rejectRefresh = reject;
        });
      });

      const validatedWorkspaceIds: Array<string | undefined> = [];
      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(peers[0]),
        profileId,
        agentDir: peers[0],
        validateOAuthCredential: (credential) => {
          const accountId = resolveOpenAICodexAuthIdentity({
            access: credential.access,
          }).accountId;
          validatedWorkspaceIds.push(accountId);
          if (accountId !== "workspace-a") {
            throw new Error("credential owner mismatch");
          }
        },
      });
      await started;
      const conflictingOwner = {
        type: "oauth" as const,
        provider,
        access: createWorkspaceAccessToken("workspace-b", "relogin"),
        refresh: "relogin-other-workspace-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        email: "shared@example.test",
      };
      await persistAuthProfileBatch({
        agentDir: peers[0],
        profiles: [{ profileId, credential: conflictingOwner }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      rejectRefresh?.(new Error("provider refresh failed"));

      await expect(resolving).rejects.toThrow("credential owner mismatch");
      expect(validatedWorkspaceIds.filter((accountId) => accountId === "workspace-b")).toHaveLength(
        1,
      );
      expect(loadPersistedAuthProfileStore(peers[0])?.profiles[profileId]).toEqual(
        conflictingOwner,
      );
      const peer = loadPersistedAuthProfileStore(peers[1])?.profiles[profileId];
      expect(peer?.type === "oauth" && isOAuthRefreshFence(peer)).toBe(true);
      expect(peer?.type === "oauth" && isPendingOAuthRefreshFence(peer)).toBe(false);
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });
});
