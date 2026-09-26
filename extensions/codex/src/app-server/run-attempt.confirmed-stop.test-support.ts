import path from "node:path";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { expectSuccessfulAttempt } from "./attempt-terminal.test-support.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

/** Keep the two-turn handoff under the parent suite's hooks and original execution order. */
export function registerConfirmedStopContinuationTest() {
  it("preserves a confirmed-stop binding for a subsequent user turn without automatic replay", async () => {
    vi.useFakeTimers();
    const sessionFile = path.join(tempDir, "session-confirmed-stop.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-confirmed-stop");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });

    // Turn 1: resume an existing thread, then remain active until the execution deadline.
    const firstHarness = createStartedThreadHarness(
      async (method) =>
        method === "thread/resume" ? threadStartResult("thread-existing") : undefined,
      { persistedThreads: ["thread-existing"] },
    );
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.timeoutMs = 60_000;
    const firstRun = runCodexAppServerAttempt(firstParams);
    await firstRun.waitForTurnAccepted();
    expect(firstHarness.requests.some((entry) => entry.method === "thread/resume")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await firstHarness.waitForMethod("turn/interrupt");
    // The real wire requires native terminal confirmation, not only an interrupt acknowledgement.
    await firstHarness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: { id: "turn-1", status: "interrupted", items: [] },
      },
    });
    const firstResult = await firstRun;
    expect(readAttemptTerminal(firstResult).timedOut).toBe(true);
    expect(readAttemptTerminal(firstResult).promptError).toBe(
      "codex app-server execution budget timed out",
    );
    expect(firstResult.promptTimeoutOutcome).toMatchObject({
      replayInvalid: true,
      livenessState: "abandoned",
    });
    expect(firstHarness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      cwd: workspaceDir,
    });

    // Confirmed interruption retains native context; only a new user admission resumes it.
    firstHarness.close();
    await vi.advanceTimersByTimeAsync(0);
    const secondHarness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          return turnStartResult("turn-2");
        }
        return undefined;
      },
      { persistedThreads: ["thread-existing"] },
    );
    const secondParams = createParams(sessionFile, workspaceDir, {
      prompt: "Continue after inspecting the work already performed.",
      runId: "run-2",
    });
    secondParams.trigger = "user";
    const secondRun = runCodexAppServerAttempt(secondParams);
    await Promise.race([secondRun, secondHarness.waitForMethod("turn/start")]);
    expect(secondHarness.requests.some(({ method }) => method === "thread/start")).toBe(false);
    expect(secondHarness.requests).toContainEqual({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-existing" }),
    });
    expect(secondHarness.requests).toContainEqual({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thread-existing",
        input: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(secondParams.prompt),
          }),
        ]),
      }),
    });
    await secondHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-2" });
    expectSuccessfulAttempt(await secondRun);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
    });
  });
}
