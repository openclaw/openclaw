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

// Production (1 turn): an embedded primary dispatched the turn without a projection and failed;
// this Codex fallback then tried to freeze its own text after dispatch and refused the turn.
it("runs after an earlier candidate dispatched the turn without a projection", async () => {
  setRuntimeConfigSnapshot({});
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_prompt_build",
        handler: () => ({ prependContext: "codex attempt context" }),
      },
    ]),
  );
  const params = createParams(path.join(tempDir, "dispatched.jsonl"), tempDir);
  const target = {
    agentId: "main",
    sessionId: "dispatched",
    sessionKey: "agent:main:dispatched",
    storePath: path.join(tempDir, "dispatched.sqlite"),
  };
  await attachSqliteSessionTarget(params, target.storePath, target.sessionId);
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const recorder = createRecorder({
    input: {
      text: params.prompt,
      idempotencyKey: "dispatched:user",
      provenance: { kind: "internal_system", sourceTool: "test" },
    },
    target: { ...target, sessionEntry: undefined },
  });
  await recorder.persistApproved();
  recorder.markSentToProvider?.();
  params.userTurnTranscriptRecorder = recorder;
  await bindProductionHarnessHostCapabilitiesForTest(params);
  let dispatchInput: unknown;
  const harness = createStartedThreadHarness(async (method, payload) => {
    if (method === "turn/start") {
      dispatchInput = payload;
    }
  });
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
  expect(JSON.stringify(dispatchInput)).toContain("codex attempt context");
  expect(JSON.stringify(dispatchInput)).toContain(params.prompt);
  expect(recorder.getPersistedMessage?.()?.["__openclaw"]?.modelPromptProjection).toBeUndefined();
});
