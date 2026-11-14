import path from "node:path";
import { expect } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { appendTranscriptEventSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../sessions/session-manager.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { buildCliSessionHistoryPrompt, loadCliSessionPromptContext } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

type RunParams = PreparedCliRunContext["params"];

export async function createHistoryBoundaryFixture(
  sessionDirs: { make(): string },
  withHeader = true,
) {
  setRuntimeConfigSnapshot({});
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
    action: (params: RunParams) => Promise<T>,
    overrides: Partial<RunParams> = {},
  ) => {
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-test");
    try {
      return await action({
        ...target,
        admittedRunContext: await admission.admit("embedded"),
        runId,
        sessionFile: target.sessionKey,
        sessionTarget: target,
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
    action: (allowed: boolean, params: RunParams) => Promise<T>,
    overrides: Partial<RunParams> = {},
    credential?: AuthProfileCredential,
    preparedBackend?: Parameters<typeof prepareCliHistoryBoundary>[1]["preparedBackend"],
  ) => {
    const runId = "boundary-run-" + ++runNumber;
    await patchSessionEntryCore(target, (entry) => ({ ...entry, activeWriterRunId: runId }));
    return await withRun(
      runId,
      async (params) => {
        const writer = await prepareCliHistoryBoundary(params, {
          credential:
            credential ??
            (epoch ? { type: "token", provider: "test-cli", token: epoch } : undefined),
          preparedBackend,
        });
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

export async function history(allowed: boolean, params: RunParams) {
  const { reseedMessages } = await loadCliSessionPromptContext({
    ...params,
    allowRawTranscriptReseed: true,
    rawTranscriptReseedReason: allowed ? "missing-transcript" : "auth-unknown",
  });
  return buildCliSessionHistoryPrompt({
    messages: reseedMessages,
    prompt: "current ask",
    maxHistoryChars: 8192,
  });
}
