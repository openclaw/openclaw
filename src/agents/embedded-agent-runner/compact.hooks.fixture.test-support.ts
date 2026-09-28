import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { drainSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  resetCompactHooksHarnessMocks,
} from "./compact.hooks.harness.js";

export function useCompactHooksSessionFixture(sessionKey: string) {
  let state: OpenClawTestState;
  let storePath: string;
  let sessionSequence = 0;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      for (const directory of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(directory);
      }
      cleanup();
    }),
  );
  afterAll(async () => {
    await state.cleanup();
  });

  return {
    async prepare() {
      state = await createOpenClawTestState({ label: "compact-hooks" });
      // A neutral custom store retains the suite's cross-agent target coverage.
      storePath = join(state.root, "sessions.json");
      return storePath;
    },
    async prepareSession() {
      const workspaceDir = tempDirs.make("openclaw-compact-hooks-", state.root);
      const sessionId = `session-${++sessionSequence}`;
      resetCompactHooksHarnessMocks(workspaceDir, sessionId);
      // Fresh transcript identities and metadata isolate cases while workers stay warm.
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      return { sessionId, workspaceDir, sessionFile: join(workspaceDir, "session.jsonl") };
    },
    makeTempDir(prefix: string) {
      return tempDirs.make(prefix, state.root);
    },
    async cleanupDirectory(directory: string) {
      await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: directory });
      await closeOpenClawAgentDatabasesAsync(directory);
      await rm(directory, { force: true, recursive: true });
    },
  };
}

export async function acquiredPreparedModelRuntime() {
  const pendingLease = acquireAgentRunPreparedModelRuntimeMock.mock.results[0]?.value;
  if (!pendingLease) {
    throw new Error("expected prepared model runtime acquisition");
  }
  return (await pendingLease).snapshot;
}

export function expectedNativeCompactionOptions(
  nativeCompactionRequest: "after_context_engine" | "required_preflight",
) {
  return {
    nativeCompactionRequest,
    preparedModelRuntime: expect.any(Object),
    sourceAuthority: { assertActive: expect.any(Function), operatorAuthority: undefined },
  };
}
