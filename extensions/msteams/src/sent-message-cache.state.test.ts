import { createHash } from "node:crypto";
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import {
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSentWithPersistence,
} from "./sent-message-cache.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

const TTL_MS = 24 * 60 * 60 * 1000;
const sentMessageMemory = resolveGlobalDedupeCache(Symbol.for("openclaw.msteamsSentMessages"), {
  ttlMs: TTL_MS,
  maxSize: 20_000,
});

function resolveNamedAccountMemory(accountId: string) {
  const digest = createHash("sha256").update(accountId).digest("hex");
  return resolveGlobalDedupeCache(Symbol.for(`openclaw.msteamsSentMessages.account.v1.${digest}`), {
    ttlMs: TTL_MS,
    maxSize: 20_000,
  });
}

describe("Teams persistent sent-message account authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sentMessageMemory.clear();
    for (const account of ["support", "finance"]) {
      resolveNamedAccountMemory(account).clear();
    }
  });
  it("keeps account and bot authority separate after memory loss while preserving legacy records", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-msteams-sent-accounts-"));
    setMSTeamsRuntime(msteamsRuntimeStub);
    const legacy = createPluginStateKeyedStoreForTests<{ sentAt: number }>("msteams", {
      namespace: "msteams.sent-messages",
      maxEntries: 1000,
      defaultTtlMs: TTL_MS,
    });
    await legacy.register("conv-1:legacy", { sentAt: Date.now() });
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "legacy",
        accountId: "default",
      }),
    ).resolves.toBe(true);

    const persisted = createDeferred<void>();
    const openStore = msteamsRuntimeStub.state.openKeyedStore;
    vi.spyOn(msteamsRuntimeStub.state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = openStore<T>(options);
        const register = store.register.bind(store);
        store.register = async (...args) => {
          try {
            await register(...args);
            persisted.resolve();
          } catch (error) {
            persisted.reject(error);
            throw error;
          }
        };
        return store;
      },
    );
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "legacy",
        accountId: "support",
      }),
    ).resolves.toBe(false);
    recordMSTeamsSentMessage("conv-1", "owned", { accountId: "support", botId: "bot-a" });
    await persisted.promise;
    resolveNamedAccountMemory("support").clear();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "owned",
        accountId: "support",
        botId: "bot-a",
      }),
    ).resolves.toBe(true);
    for (const scope of [
      { accountId: "finance", botId: "bot-a" },
      { accountId: "support", botId: "bot-b" },
    ]) {
      await expect(
        wasMSTeamsMessageSentWithPersistence({
          conversationId: "conv-1",
          messageId: "owned",
          ...scope,
        }),
      ).resolves.toBe(false);
    }
    recordMSTeamsSentMessage("conv-1", "unknown", { accountId: "support", botId: "bot-a" });
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "unknown",
        accountId: "support",
        botId: "bot-a",
      }),
    ).resolves.toBe(false);
  });
});
