import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it, vi } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  fastWait,
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
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

it("keeps explicitly retained reset messages in the Codex prompt", async () => {
  const manager = SessionManager.inMemory();
  const retained = {
    role: "user" as const,
    content: "EXPLICITLY_RETAINED_FACT",
    timestamp: 1,
    excludeFromContext: true,
  };
  const retainedId = manager.appendMessage(retained);
  manager.appendResetBoundary("reset", retainedId);
  manager.appendMessage({ role: "user", content: "next question", timestamp: 2 });
  const messages = manager.buildSessionContext().messages;
  expect(messages).toContainEqual(expect.objectContaining(retained));
  const projection = await projectContextEngineAssemblyForCodex({
    assembledMessages: messages,
    originalHistoryMessages: messages,
    prompt: "next question",
  });
  expect(projection.promptText).toContain("EXPLICITLY_RETAINED_FACT");
});

it.each(["started", "resumed"] as const)(
  "hands off durable note-only history to a %s thread without replaying transient context",
  async (action) => {
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    await attachSqliteSessionTarget(params, path.join(tempDir, "notes.sqlite"), "session-1");
    const cutoff = Date.now() - 1_000;
    if (action === "resumed") {
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
    }
    const target = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    };
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
    const excludedNote = {
      ...note,
      idempotencyKey: "excluded",
      content: "EXCLUDED_NOTE",
      excludeFromContext: true,
    };
    manager.appendMessage(excludedNote);
    const transientNote = {
      ...note,
      idempotencyKey: "transient",
      customType: "openclaw.runtime-context",
      content: "TRANSIENT_NOTE",
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    };
    manager.appendMessage(transientNote);
    if (action === "resumed") {
      const coveredNote = {
        ...note,
        idempotencyKey: "covered",
        content: "ALREADY_COVERED_NOTE",
        timestamp: cutoff,
      };
      manager.appendMessage(coveredNote);
      const nativeMirrorNote = {
        ...note,
        content: "NATIVE_MIRROR_NOTE",
        idempotencyKey: "codex-app-server:synthetic",
      };
      manager.appendMessage(nativeMirrorNote);
    }
    const threadId = action === "started" ? "thread-1" : "thread-existing";
    let turnNumber = 0;
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return threadStartResult(threadId);
        }
        if (method === "turn/start") {
          return turnStartResult(`turn-${++turnNumber}`);
        }
        return undefined;
      },
      { persistedThreads: action === "resumed" ? [threadId] : [] },
    );
    const run = runCodexAppServerAttempt(params);
    await Promise.race([harness.waitForMethod("turn/start"), run]);
    await harness.completeTurn({ threadId, turnId: "turn-1" });
    await run;
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
    await Promise.race([vi.waitFor(() => expect(turnNumber).toBe(2), fastWait), next]);
    await harness.completeTurn({ threadId, turnId: "turn-2" });
    await next;
    const nextRequest = harness.requests.findLast((item) => item.method === "turn/start");
    expect(JSON.stringify(nextRequest?.params)).not.toContain("Imported durable result");
  },
);

it("advances history coverage after successful local message-tool completion", async () => {
  const sessionFile = path.join(tempDir, "local-source-reply-session.jsonl");
  const workspaceDir = path.join(tempDir, "local-source-reply-workspace");
  const cutoff = Date.now() - 1_000;
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-1",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    dynamicToolsFingerprint: "[]",
    historyCoveredThrough: new Date(cutoff).toISOString(),
    webSearchThreadConfigFingerprint: JSON.stringify({
      "features.standalone_web_search": false,
      web_search: "disabled",
    }),
  });

  const messageTool = createRuntimeDynamicTool("message");
  messageTool.parameters = {
    type: "object",
    properties: {
      action: { type: "string" },
      message: { type: "string" },
    },
    additionalProperties: true,
  };
  messageTool.execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Sent." }],
    details: { messageId: "telegram-123" },
  }));
  dynamicToolBuildState.openClawCodingToolsFactory = () => [messageTool];

  const params = createParams(sessionFile, workspaceDir);
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.sourceReplyDeliveryMode = "message_tool_only";
  setCodexTestModelSupportsTools(params, true);
  const harness = createStartedThreadHarness();
  const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
  const run = runCodexAppServerAttempt(params);
  try {
    await harness.waitForMethod("turn/start");
    const response = await harness.handleServerRequest({
      id: "local-source-reply",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
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
    await run;
    const binding = await readCodexAppServerBinding(sessionFile);
    const coveredThrough = Date.parse(binding?.historyCoveredThrough ?? "");
    expect(Number.isFinite(coveredThrough)).toBe(true);
    expect(coveredThrough).toBeGreaterThan(cutoff);
  } finally {
    closeHostCapabilities();
    harness.close();
  }
});
