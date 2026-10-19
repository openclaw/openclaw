import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  assistantMessage,
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as settledTurnContext from "./settled-turn-context.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

async function createDurableParams(name: string) {
  const params = createParams(path.join(tempDir, `${name}.jsonl`), path.join(tempDir, "workspace"));
  await attachSqliteSessionTarget(params, path.join(tempDir, `${name}.sqlite`), "session-1");
  const target = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey!,
    storePath: params.sessionTarget!.storePath!,
  };
  return { params, target };
}

function createDurableHarness(
  threadId: string,
  persisted: boolean,
  startedThread: (count: number) => string,
) {
  let threads = 0;
  let turns = 0;
  const harness = createStartedThreadHarness(
    async (method) => {
      if (method === "thread/start") {
        return threadStartResult(startedThread(++threads));
      }
      if (method === "thread/resume") {
        return threadStartResult(threadId);
      }
      if (method === "turn/start") {
        return turnStartResult(`turn-${++turns}`);
      }
      return undefined;
    },
    { persistedThreads: persisted ? [threadId] : [] },
  );
  return { harness, turns: () => turns, threads: () => threads };
}

it("hands off durable notes once on resume without replaying transient context", async () => {
  const { params, target } = await createDurableParams("notes");
  const cutoff = Date.now() - 1_000;
  await writeCodexAppServerBinding(params.sessionFile, {
    threadId: "thread-existing",
    cwd: params.workspaceDir,
    model: params.modelId,
    modelProvider: "openai",
    dynamicToolsFingerprint: "[]",
    historyCoveredThrough: new Date(cutoff).toISOString(),
    webSearchThreadConfigFingerprint: JSON.stringify({
      "features.standalone_web_search": false,
      web_search: "disabled",
    }),
  });
  const manager = SessionManager.open(target);
  const note = {
    role: "custom" as const,
    customType: "openclaw.system-note",
    content: "Imported durable result: inbox cleared",
    display: false,
    timestamp: Date.now(),
    idempotencyKey: "doctor:heartbeat-outcome:synthetic",
  };
  manager.appendMessage(note);
  for (const override of [
    { idempotencyKey: "excluded", content: "EXCLUDED_NOTE", excludeFromContext: true },
    {
      idempotencyKey: "transient",
      content: "TRANSIENT_NOTE",
      customType: "openclaw.runtime-context",
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    },
    { idempotencyKey: "covered", content: "ALREADY_COVERED_NOTE", timestamp: cutoff },
    { idempotencyKey: "codex-app-server:synthetic", content: "NATIVE_MIRROR_NOTE" },
  ]) {
    manager.appendMessage({ ...note, ...override });
  }
  const threadId = "thread-existing";
  const { harness, turns } = createDurableHarness(threadId, true, () => "thread-1");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  await harness.completeTurn({ threadId, turnId: "turn-1" });
  await run;
  await nativeHookRelayUnregisterQueue.flush();
  const request = harness.requests.find((item) => item.method === "turn/start");
  const input = JSON.stringify(request?.params);
  expect(input).toContain("Imported durable result: inbox cleared");
  expect(input).toContain("[custom]");
  expect(input).not.toContain("TRANSIENT_NOTE");
  expect(input).not.toContain("EXCLUDED_NOTE");
  expect(input).not.toContain("ALREADY_COVERED_NOTE");
  expect(input).not.toContain("NATIVE_MIRROR_NOTE");
  const binding = await readCodexAppServerBinding(params.sessionFile);
  expect(Date.parse(binding!.historyCoveredThrough!)).toBeGreaterThanOrEqual(note.timestamp);

  const nextParams = createParams(params.sessionFile, params.workspaceDir, {
    runId: "run-2",
    prompt: "Continue.",
  });
  nextParams.sessionTarget = params.sessionTarget;
  const next = runCodexAppServerAttempt(nextParams);
  await next.waitForTurnAccepted();
  expect(turns()).toBe(2);
  await harness.completeTurn({ threadId, turnId: "turn-2" });
  await next;
  await nativeHookRelayUnregisterQueue.flush();
  const nextRequest = harness.requests.findLast((item) => item.method === "turn/start");
  expect(JSON.stringify(nextRequest?.params)).not.toContain("Imported durable result");
});

it("does not replay covered history on the same thread after local message-tool completion", async () => {
  const { params, target } = await createDurableParams("local-source-reply");
  const { sessionFile } = params;
  const messageTool = createRuntimeDynamicTool("message");
  messageTool.parameters = {
    type: "object",
    properties: { action: { type: "string" }, message: { type: "string" } },
    additionalProperties: true,
  };
  messageTool.execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Sent." }],
    details: { messageId: "telegram-123" },
  }));

  setCodexTestToolFactory(params, () => [messageTool]);
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.sourceReplyDeliveryMode = "message_tool_only";
  setCodexTestModelSupportsTools(params, true);
  const threadId = "thread-local-source-1";
  const { harness, turns, threads } = createDurableHarness(
    threadId,
    false,
    (count) => `thread-local-source-${count}`,
  );
  const append = async (
    message: Parameters<typeof appendSessionTranscriptMessageByIdentity>[0]["message"],
  ) => {
    await expect(
      appendSessionTranscriptMessageByIdentity({ ...target, message }),
    ).resolves.toMatchObject({ appended: true });
  };
  let closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
  try {
    // Keep the history timestamps and attempt deadlines on the same controlled clock.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const first = runCodexAppServerAttempt(params);
    await first.waitForTurnAccepted();
    await harness.completeTurn({ threadId, turnId: "turn-1" });
    expect((await first).terminal).toEqual({ kind: "ok" });
    await nativeHookRelayUnregisterQueue.flush();
    const originalBinding = await readCodexAppServerBinding(sessionFile);
    expect(originalBinding).toMatchObject({ threadId });
    const originalCutoff = Date.parse(originalBinding!.historyCoveredThrough!);
    expect(Number.isFinite(originalCutoff)).toBe(true);
    closeHostCapabilities();

    vi.setSystemTime(Date.now() + 1_000);
    await append({ role: "user", content: "old user: cobalt", timestamp: Date.now() });
    await append(assistantMessage("old assistant: cobalt", Date.now()));
    vi.setSystemTime(Date.now() + 1_000);
    params.runId = "run-2";
    params.prompt = "Send the inventory summary.";
    closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const capture = vi.spyOn(settledTurnContext, "captureCodexSettledTurnFinalizationContext");
    const onSettledTurn = vi.fn(async () => {});
    params.onSettledTurn = onSettledTurn;
    const terminal = runCodexAppServerAttempt(params);
    await terminal.waitForTurnAccepted();
    expect(turns()).toBe(2);
    const terminalRequest = harness.requests.findLast((item) => item.method === "turn/start");
    expect(terminalRequest?.params).toMatchObject({ threadId });
    expect(JSON.stringify(terminalRequest?.params)).toContain("old user: cobalt");
    expect(JSON.stringify(terminalRequest?.params)).toContain("old assistant: cobalt");
    const response = await harness.handleServerRequest({
      id: "local-source-reply",
      method: "item/tool/call",
      params: {
        threadId,
        turnId: "turn-2",
        callId: "local-source-reply",
        namespace: null,
        tool: "message",
        arguments: { action: "send", message: "visible reply" },
      },
    });
    expect(response).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: "Sent." }],
    });
    expect(messageTool.execute).toHaveBeenCalledOnce();
    await harness.waitForMethod("turn/interrupt");
    await harness.notify({
      method: "turn/completed",
      params: { threadId, turn: { id: "turn-2", status: "interrupted", items: [] } },
    });
    expect((await terminal).terminal).toEqual({ kind: "ok" });
    expect(capture).not.toHaveBeenCalled();
    expect(onSettledTurn).toHaveBeenCalledOnce();
    await nativeHookRelayUnregisterQueue.flush();
    const binding = await readCodexAppServerBinding(sessionFile);
    const coveredThrough = Date.parse(binding?.historyCoveredThrough ?? "");
    expect(binding).toMatchObject({ threadId });
    expect(Number.isFinite(coveredThrough)).toBe(true);
    expect(coveredThrough).toBeGreaterThan(originalCutoff);
    closeHostCapabilities();

    vi.setSystemTime(Date.now() + 1_000);
    await append({ role: "user", content: "new user: amber", timestamp: Date.now() });
    vi.setSystemTime(Date.now() + 1_000);
    params.runId = "run-3";
    params.prompt = "Use the corrected inventory.";
    closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const next = runCodexAppServerAttempt(params);
    await next.waitForTurnAccepted();
    expect(turns()).toBe(3);
    await harness.completeTurn({ threadId, turnId: "turn-3" });
    expect((await next).terminal).toEqual({ kind: "ok" });
    await nativeHookRelayUnregisterQueue.flush();
    const nextRequest = harness.requests.findLast((item) => item.method === "turn/start");
    expect(nextRequest?.params).toMatchObject({ threadId });
    const nextInput = JSON.stringify(nextRequest?.params);
    expect(nextInput).toContain("new user: amber");
    expect(nextInput).toContain("Use the corrected inventory.");
    expect(nextInput).not.toContain("old user: cobalt");
    expect(nextInput).not.toContain("old assistant: cobalt");
    expect(threads()).toBe(1);
  } finally {
    closeHostCapabilities();
    harness.close();
    vi.useRealTimers();
  }
});
