import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it } from "vitest";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
} from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

it("freezes only the hook-enriched current user projection before native dispatch", async () => {
  setRuntimeConfigSnapshot({});
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_prompt_build",
        handler: () => ({ prependContext: "hook prefix", appendContext: "hook suffix" }),
      },
    ]),
  );
  const params = createParams(path.join(tempDir, "projection.jsonl"), tempDir);
  const target = {
    agentId: "main",
    sessionId: "projection",
    sessionKey: "agent:main:projection",
    storePath: path.join(tempDir, "projection.sqlite"),
  };
  await attachSqliteSessionTarget(params, target.storePath, target.sessionId);
  await appendSqliteHistoryMessage(params, userMessage("older history must stay separate", 1));
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const recorder = createRecorder({
    input: {
      text: params.prompt,
      idempotencyKey: "projection:user",
      provenance: { kind: "internal_system", sourceTool: "test" },
    },
    target: { ...target, sessionEntry: undefined },
  });
  await recorder.persistApproved();
  params.userTurnTranscriptRecorder = recorder;
  await bindProductionHarnessHostCapabilitiesForTest(params);
  const expected = "hook prefix\n\nhello\n\nhook suffix";
  let dispatchProjection: unknown;
  const harness = createStartedThreadHarness(async (method) => {
    if (method === "turn/start") {
      dispatchProjection = recorder.getPersistedMessage?.()?.["__openclaw"]?.modelPromptProjection;
    }
  });
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
  expect(dispatchProjection).toEqual({ version: 1, text: expected });
  expect(recorder.getPersistedMessage?.()?.["__openclaw"]?.mirrorIdentity).toBe("turn-1:prompt");
  // The same admitted turn can cross into the embedded fallback after native dispatch.
  await expect(recorder.captureModelPromptProjection!(expected, () => {})).resolves.toMatchObject({
    content: "hello",
    __openclaw: { modelPromptProjection: { version: 1, text: expected } },
  });
});
