// Shared session fixture for the CLI transcript account boundary tests.
import path from "node:path";
import { expect } from "vitest";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { appendTranscriptEventSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../sessions/session-manager.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { buildCliSessionHistoryPrompt, loadCliSessionPromptContext } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

type SessionStoreTempDirs = ReturnType<typeof useSessionStoreTempDirs>;

export async function createHistoryBoundaryFixture(
  sessionDirs: SessionStoreTempDirs,
  withHeader = true,
) {
  const dir = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId: "history",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  if (withHeader) {
    appendTranscriptEventSync(target, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: target.sessionId,
      cwd: dir,
      timestamp: new Date(0).toISOString(),
    });
  }
  const manager = () => SessionManager.open(target, dir);
  let runNumber = 0;
  const withRun = async <T>(
    runId: string,
    action: (params: PreparedCliRunContext["params"]) => Promise<T>,
    overrides: Partial<PreparedCliRunContext["params"]> = {},
  ) => {
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-test");
    try {
      return await action({
        admittedRunContext: await admission.admit("embedded"),
        runId,
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        storePath: target.storePath,
        provider: "test-cli",
        model: "test-model",
        prompt: "current ask",
        workspaceDir: dir,
        timeoutMs: 1000,
        ...overrides,
      });
    } finally {
      admission.close();
    }
  };
  const run = async <T>(
    epoch: string | undefined,
    action: (allowed: boolean, params: PreparedCliRunContext["params"]) => Promise<T>,
    overrides: Partial<PreparedCliRunContext["params"]> = {},
    credential?: AuthProfileCredential,
    preparedBackend?: Parameters<typeof prepareCliHistoryBoundary>[2],
  ) => {
    const runId = "boundary-run-" + ++runNumber;
    await patchSessionEntryCore(target, (entry) => ({ ...entry, activeWriterRunId: runId }));
    return await withRun(
      runId,
      async (params) => {
        const writer = await prepareCliHistoryBoundary(
          params,
          credential ?? (epoch ? { type: "token", provider: "test-cli", token: epoch } : undefined),
          preparedBackend,
        );
        return await runWithCliHistoryWriter(writer, () => action(Boolean(writer), params));
      },
      overrides,
    );
  };
  const seed = async () =>
    await run("epoch-a", async (allowed) => {
      expect(allowed).toBe(true);
      manager().appendMessage({ role: "user", content: "A private canary", timestamp: 1 });
    });
  return { target, manager, run, seed, withRun };
}

export async function history(allowed: boolean, params: PreparedCliRunContext["params"]) {
  return buildCliSessionHistoryPrompt({
    messages: (
      await loadCliSessionPromptContext({
        ...params,
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: allowed ? "missing-transcript" : "auth-unknown",
      })
    ).reseedMessages,
    prompt: "current ask",
    maxHistoryChars: 8192,
  });
}
