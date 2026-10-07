import fs from "node:fs/promises";
import path from "node:path";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  cleanupSessionStateForTest,
  drainSessionStateForTest,
} from "../../test-utils/session-state-cleanup.js";
import {
  createSessionEntry,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import {
  makeToolResultMessage,
  makeUserMessage,
} from "./main-session-restart-recovery-transcript.test-support.js";

/** Reuses the default-main transcript database across recovery cases. */
function createRestartRecoveryTranscriptFixture() {
  let preparedRoot: string | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      if (preparedRoot) {
        await cleanupSessionStateForTest({ stateDir: preparedRoot });
      }
      cleanup();
    }),
  );

  async function writeTranscript(
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ): Promise<void> {
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = Object.entries(readStore(storePath)).find(
      ([, entry]) => entry.sessionId === sessionId,
    )?.[0];
    if (!sessionKey) {
      throw new Error(`expected session entry for transcript fixture: ${sessionId}`);
    }
    for (const message of messages) {
      await appendTranscriptMessage(
        { sessionId, sessionKey, storePath },
        {
          cwd: sessionsDir,
          message,
        },
      );
    }
  }

  return {
    writeTranscript,
    prepareRoot: (): string =>
      (preparedRoot ??= tempDirs.make("openclaw-recovery-transcript-fixture-")),
    reset: async (stateDir: string): Promise<void> => {
      if (stateDir !== preparedRoot) {
        return;
      }
      await drainSessionStateForTest({ stateDir });
      await applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
        // These cases reuse this one identity; remove every owned window.
        removals: [{ sessionKey: "agent:main:main", deleteOwnedWindows: true }],
        skipMaintenance: true,
      });
      await drainSessionStateForTest({ stateDir });
    },
  };
}

export function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    permissionMode: "guarded",
    updatedAt: Date.now() - 10_000,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
    ...overrides,
  });
}

export function makePendingFinalDelivery(
  text = "interrupted response",
  overrides: Partial<NonNullable<SessionEntry["pendingFinalDelivery"]>> = {},
): NonNullable<SessionEntry["pendingFinalDelivery"]> {
  return {
    kind: "replayable",
    text,
    createdAt: Date.now(),
    intentId: "intent-prepared-default",
    deliveries: [{ id: "delivery-prepared-default", state: "prepared" }],
    ...overrides,
  };
}

export function readStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

export function createRestartRecoveryStoreFixture(getStateDir: () => string) {
  const transcriptFixture = createRestartRecoveryTranscriptFixture();
  const { writeTranscript } = transcriptFixture;
  async function makeSessionsDir(agentId = "main"): Promise<string> {
    const sessionsDir = path.join(getStateDir(), "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    return sessionsDir;
  }

  async function writeStorePath(
    storePath: string,
    store: Record<string, SessionEntryFixture>,
  ): Promise<void> {
    await Promise.all(
      Object.entries(store).map(([sessionKey, entry]) =>
        replaceSessionEntry({ storePath, sessionKey }, createSessionEntry(entry)),
      ),
    );
  }

  async function writeStore(
    sessionsDir: string,
    store: Record<string, SessionEntryFixture>,
  ): Promise<void> {
    await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
  }

  async function writeCompletedToolTranscript(sessionsDir: string, human = false): Promise<void> {
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("run the tool", human ? { provenance: { kind: "external_user" } } : {}),
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      makeToolResultMessage(),
    ]);
  }

  return {
    makeSessionsDir,
    writeStorePath,
    writeStore,
    transcriptFixture,
    writeTranscript,
    writeCompletedToolTranscript,
  };
}
