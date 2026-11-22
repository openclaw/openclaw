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
const { refreshProviderOAuthCredentialWithPluginMock: refresh } = mocks;
const profileId = "openai:default";
const provider = "openai";

// mock-isolation: Synthetic credentials must not enter real provider discovery or network OAuth.
vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

function reset() {
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks(mocks);
  clearRuntimeAuthProfileStoreSnapshots();
}
beforeEach(reset);
afterEach(reset);

it.each(["peer fence", "owner commit"] as const)(
  "does not replay an uncertain %s after the provider consumes the generation",
  (stage) =>
    withOpenClawTestState(
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
        refresh.mockImplementation(async () => {
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
        const loseReply = async <T>(operation: () => Promise<T>, selected = true) => {
          if (selected) {
            attempts++;
          }
          const result = await operation();
          if (selected && attempts === 1) {
            throw lostReply;
          }
          return result;
        };
        const fence = candidates.fenceCandidateAuthProfileStore;
        const settle = oauthStore.settleOAuthRefreshClaim;
        using _ =
          stage === "peer fence"
            ? vi
                .spyOn(candidates, "fenceCandidateAuthProfileStore")
                .mockImplementation((params) =>
                  loseReply(
                    () => fence(params),
                    params.candidate.databasePath === resolveAuthProfileDatabasePath(lateDir),
                  ),
                )
            : vi
                .spyOn(oauthStore, "settleOAuthRefreshClaim")
                .mockImplementation((params) => loseReply(() => settle(params)));

        await expect(resolveFrom(peerDir)).rejects.toThrow(
          stage === "peer fence"
            ? "Failed to fence every historical OAuth refresh peer"
            : lostReply.message,
        );
        expect(attempts).toBe(1);
        expect(refresh).toHaveBeenCalledOnce();
        if (stage === "peer fence") {
          for (const dir of [mainAgentDir, peerDir, lateDir]) {
            const terminal = read(dir);
            expect(terminal?.type === "oauth" && isOAuthRefreshFence(terminal)).toBe(true);
            expect(terminal?.type === "oauth" && isPendingOAuthRefreshFence(terminal)).toBe(false);
          }
        } else {
          expect(read(mainAgentDir)).toMatchObject(replacement);
          const peer = read(peerDir);
          expect(peer?.type === "oauth" && isPendingOAuthRefreshFence(peer)).toBe(true);
        }
      },
    ),
);
