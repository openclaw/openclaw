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
    sourceAuthority: {
      assertActive: expect.any(Function),
      prepareDispatch: expect.any(Function),
      operatorAuthority: undefined,
    },
  };
}

// Bind the array-backed fixture history without replacing caller accounting or authority.
export async function createCompactHooksDirectRunner(
  compact: typeof import("./compact.js").compactEmbeddedAgentSessionDirect,
  defaults: () => { sessionKey: string; storePath: string },
): Promise<typeof compact> {
  const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
  const { SessionManager: FixtureSessionManager } = await import("../sessions/index.js");
  const { attachCompactionAccountingRecorder, readCompactionAccountingRecorder } =
    await import("./run/compaction-accounting-bridge.js");
  const { captureOwnedTranscriptWriteAssertion } =
    await import("../../config/sessions/transcript-write-context.js");
  return async (params) => {
    setRuntimeConfigSnapshot(params.config ?? {});
    const sessionTarget = {
      ...params.sessionTarget,
      agentId: params.sessionTarget?.agentId ?? "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionTarget?.sessionKey ?? params.sessionKey ?? defaults().sessionKey,
      storePath: params.sessionTarget?.storePath ?? defaults().storePath,
    };
    const contextEngineRuntimeContext = params.contextEngineRuntimeContext ?? {};
    const accounting = readCompactionAccountingRecorder(contextEngineRuntimeContext);
    let assertWrite: (() => void) | undefined;
    // The array fixture owns this history. Capture the normal write assertion when execution
    // enters its owner, while retaining any pending-request or custom-session accounting.
    attachCompactionAccountingRecorder(contextEngineRuntimeContext, {
      ...accounting,
      memoryTranscript: accounting?.memoryTranscript ?? {
        sessionTarget,
        sessionManager: await FixtureSessionManager.openAsync(sessionTarget),
        assertActive: () => (assertWrite ??= captureOwnedTranscriptWriteAssertion(sessionTarget))(),
      },
    });
    return compact({
      agentId: "main",
      ...params,
      contextEngineRuntimeContext,
    });
  };
}
