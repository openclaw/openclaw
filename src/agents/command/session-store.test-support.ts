// Shares durable session-store fixtures and run results across command tests.
import path from "node:path";
import { onTestFinished } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import {
  recordCliCompactionInStore,
  updateSessionStoreAfterAgentRun as updateSessionStoreAfterAgentRunBase,
} from "./session-store.js";

export async function seedSessionFixture(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<Record<string, SessionEntry>> {
  const sessionStore = { [sessionKey]: entry };
  await seedSessionStore(storePath, sessionStore);
  return sessionStore;
}

export async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  const dir = lifetime.createTempDir("openclaw-session-store-");
  try {
    return await lifetime.run(async () => {
      try {
        return await run({ dir, storePath: path.join(dir, "sessions.json") });
      } finally {
        await lifetime.verifyCleanup(async () => {
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();
        });
      }
    });
  } finally {
    await lifetime.cleanup();
  }
}

export async function seedSessionStore(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await patchSessionEntryCore({ storePath, sessionKey }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
}

export function loadPersistedSessionStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

export function loadPersistedSessionEntry(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  return loadSessionEntry({ storePath, sessionKey }) ?? undefined;
}

type SessionStoreUpdateParams = Parameters<typeof updateSessionStoreAfterAgentRunBase>[0];

export async function updateSessionStoreAfterAgentRun(
  params: Omit<SessionStoreUpdateParams, "agentDir" | "agentId"> & {
    agentDir?: string;
    agentId?: string;
  },
) {
  await updateSessionStoreAfterAgentRunBase({
    ...params,
    agentId: params.agentId ?? "main",
    agentDir: params.agentDir ?? "/tmp/openclaw-session-store-test-agent",
  });
}

export function createRunResult(
  agentMeta: NonNullable<EmbeddedAgentRunResult["meta"]["agentMeta"]>,
  meta: Partial<Omit<EmbeddedAgentRunResult["meta"], "agentMeta">> = {},
): EmbeddedAgentRunResult {
  return { meta: { durationMs: 1, ...meta, agentMeta } };
}

const sessionId = "test-session";
const sessionKey = "agent:main:explicit:test-session";
type Update = Parameters<typeof updateSessionStoreAfterAgentRun>[0];
type Compact = Parameters<typeof recordCliCompactionInStore>[0];

export async function withSession(
  run: (fixture: {
    storePath: string;
    sessionStore: Record<string, SessionEntry>;
    seed: (patch?: Partial<SessionEntry>) => Promise<SessionEntry>;
    update: (params?: Partial<Update>) => Promise<void>;
    compact: (
      params: Pick<Compact, "compactionKind" | "expectedSession" | "tokensAfter">,
    ) => Promise<SessionEntry | undefined>;
    read: () => SessionEntry | undefined;
  }) => Promise<void>,
) {
  await withTempSessionStore(async ({ storePath }) => {
    const sessionStore: Record<string, SessionEntry> = {};
    await run({
      storePath,
      sessionStore,
      seed: async (patch = {}) => {
        const entry: SessionEntry = { sessionId, updatedAt: 1, ...patch };
        await seedSessionStore(storePath, { [sessionKey]: entry });
        sessionStore[sessionKey] = entry;
        return entry;
      },
      update: (params = {}) =>
        updateSessionStoreAfterAgentRun({
          cfg: {},
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          result: createRunResult({ sessionId, provider: "openai", model: "gpt-5.5" }),
          ...params,
        }),
      compact: (params) =>
        recordCliCompactionInStore({
          agentId: "main",
          sessionKey,
          sessionStore,
          storePath,
          ...params,
        }),
      read: () => loadPersistedSessionEntry(storePath, sessionKey),
    });
  });
}
