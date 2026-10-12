import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  createExpiredOauthStore,
  resetOAuthProviderRuntimeMocks,
  resolveApiKeyForProfileInTest,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";

const mocks = getOAuthProviderRuntimeMocks();
const { refreshProviderOAuthCredentialWithPluginMock } = mocks;
const profileId = "openai:default";
const provider = "openai";

// mock-isolation: Synthetic credentials must not enter real provider discovery or network OAuth.
vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

beforeEach(async () => {
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks(mocks);
  clearRuntimeAuthProfileStoreSnapshots();
  const { resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js");
  resetOAuthRefreshQueuesForTest();
});
afterEach(() => {
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks(mocks);
  clearRuntimeAuthProfileStoreSnapshots();
});

it.each(["peer fence", "owner commit"] as const)(
  "does not replay an uncertain %s after the provider consumes the generation",
  async (stage) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "oauth-uncertain-settlement" },
      async (state) => {
        const [candidates, oauthStore, { SqliteWorkerError }, { resolveApiKeyForProfile }] =
          await Promise.all([
            import("./candidate-stores.js"),
            import("./oauth-store.js"),
            import("../../infra/sqlite-worker-contract.js"),
            import("./oauth.js"),
          ]);
        const mainAgentDir = state.agentDir();
        const peerDir = state.agentDir("peer-a");
        const lateDir = state.agentDir("peer-z");
        const read = (dir: string) => loadPersistedAuthProfileStore(dir)?.profiles[profileId];
        const resolveFrom = (agentDir: string) =>
          resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
            store: ensureAuthProfileStore(agentDir),
            profileId,
            agentDir,
          });
        await Promise.all([peerDir, lateDir].map((dir) => fs.mkdir(dir, { recursive: true })));
        const original = createExpiredOauthStore({ profileId, provider });
        saveAuthProfileStore(original, peerDir);
        saveAuthProfileStore(original, mainAgentDir);
        const replacement = {
          type: "oauth" as const,
          provider,
          access: "synthetic-lost-reply-access",
          refresh: "synthetic-lost-reply-refresh",
          expires: Date.now() + 60 * 60 * 1000,
        };
        refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
          if (stage === "peer fence") {
            writePersistedAuthProfileStoreRaw(original, lateDir);
          }
          return replacement;
        });
        const lostReply = new SqliteWorkerError(
          `Synthetic lost ${stage} acknowledgment`,
          "outcome-unknown",
        );
        let attempts = 0;
        let restore: () => void;
        if (stage === "peer fence") {
          const fence = candidates.fenceCandidateAuthProfileStore;
          const spy = vi
            .spyOn(candidates, "fenceCandidateAuthProfileStore")
            .mockImplementation(async (params) => {
              const selected =
                params.candidate.databasePath === resolveAuthProfileDatabasePath(lateDir);
              if (selected) {
                attempts++;
              }
              await fence(params);
              if (selected && attempts === 1) {
                throw lostReply;
              }
            });
          restore = () => spy.mockRestore();
        } else {
          const settle = oauthStore.settleOAuthRefreshClaim;
          const spy = vi
            .spyOn(oauthStore, "settleOAuthRefreshClaim")
            .mockImplementation(async (params) => {
              attempts++;
              const result = await settle(params);
              if (attempts === 1) {
                throw lostReply;
              }
              return result;
            });
          restore = () => spy.mockRestore();
        }
        try {
          await expect(resolveFrom(peerDir)).rejects.toThrow(
            stage === "peer fence"
              ? "Failed to fence every historical OAuth refresh peer"
              : lostReply.message,
          );
          expect(attempts).toBe(1);
          expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
          if (stage === "peer fence") {
            for (const dir of [mainAgentDir, peerDir, lateDir]) {
              const terminal = read(dir);
              expect(terminal?.type === "oauth" && isOAuthRefreshFence(terminal)).toBe(true);
              expect(terminal?.type === "oauth" && isPendingOAuthRefreshFence(terminal)).toBe(
                false,
              );
            }
          } else {
            expect(read(mainAgentDir)).toMatchObject(replacement);
            const peer = read(peerDir);
            expect(peer?.type === "oauth" && isPendingOAuthRefreshFence(peer)).toBe(true);
          }
        } finally {
          restore();
        }
      },
    );
  },
);
