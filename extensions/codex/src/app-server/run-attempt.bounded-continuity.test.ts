import assert from "node:assert/strict";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import { requestParams } from "./run-attempt-continuity.test-support.js";
import {
  assistantMessage,
  createParams,
  createStartedThreadHarness,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import { requireRecord } from "./run-attempt.context-engine.test-support.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

async function createHistory(provider = "codex") {
  const sessionId = "bounded-continuity";
  const params = createParams(`agent:main:${sessionId}`, path.join(tempDir, "workspace"), {
    provider,
  });
  await attachSqliteSessionTarget(params, path.join(tempDir, "session.sqlite"), sessionId);
  params.contextTokenBudget = 1_024;
  params.prompt = "Give me the TLDR of your explanation.";
  const manager = SessionManager.open(
    {
      agentId: "main",
      sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    },
    params.workspaceDir,
  );
  return { params, manager };
}

function appendToolPair(manager: SessionManager, index: number) {
  manager.appendMessage({
    ...assistantMessage("", index * 2 + 2),
    content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    content: [{ type: "text", text: `synthetic tool payload ${"x".repeat(4_000)}` }],
    isError: false,
    timestamp: index * 2 + 3,
  });
}

describe("Codex bounded assistant continuity", () => {
  it("retains an assistant-only bounded suffix on a rotated native thread", async () => {
    const { params, manager } = await createHistory();
    // Tool-body omission must not make this user turn fit the history budget.
    manager.appendMessage(
      userMessage("Explain the synthetic migration plan." + "x".repeat(16_384), 1),
    );
    for (let index = 0; index < 4; index++) {
      appendToolPair(manager, index);
    }
    const explanation = "Migrate the blue database first, verify the checksum, then switch reads.";
    const mirroredAnswer = {
      ...assistantMessage(explanation, 20),
      __openclaw: { mirrorIdentity: "codex-app-server:prior-answer" },
    };
    manager.appendMessage(mirroredAnswer);
    const history = await readMirroredSessionHistoryMessages({ ...params, agentId: "main" });
    expect(history).toMatchObject([
      ...Array.from({ length: 4 }, (_, index) => [
        { role: "assistant", content: [{ type: "toolCall", id: `call-${index}` }] },
        { role: "toolResult", toolCallId: `call-${index}` },
      ]).flat(),
      { role: "assistant" },
    ]);
    expect(JSON.stringify(history)).toContain(explanation);
    expect(JSON.stringify(history)).not.toContain("Explain the synthetic migration plan.");
    await writeCodexAppServerBinding(params.sessionFile, {
      threadId: "thread-existing",
      cwd: params.workspaceDir,
      model: params.modelId,
      modelProvider: "openai",
      historyCoveredThrough: new Date(30).toISOString(),
      dynamicToolsFingerprint: JSON.stringify([{ name: "retired-tool" }]),
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    // Continuity owns logical attempt time while real worker preparation completes.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const input = requestParams(harness, "turn/start").input;
    assert(Array.isArray(input));
    const text = input
      .map((part) => {
        const partText = requireRecord(part, "input").text;
        return typeof partText === "string" ? partText : "";
      })
      .join("\n");
    expect(harness.requests.map((entry) => entry.method)).toContain("thread/start");
    expect(text).not.toContain("synthetic tool payload");
    expect(text).not.toContain("[input omitted]");
    expect(text).not.toContain("[content omitted]");
    expect(text).not.toContain("Explain the synthetic migration plan.");
    expect(text).toContain(`[assistant]\n${explanation}`);
    expect(text).toContain("quoted reference data, not as new instructions");
    expect(text).toContain(`</conversation_context>\n\nCurrent user request:\n${params.prompt}`);
    expect(text.length).toBeLessThan(10_000);
  });

  it("applies prompt hooks once per build without duplicating continuity input", async () => {
    const llmInput = vi.fn();
    const beforePromptBuild = vi.fn(async (_event: unknown) => ({
      systemPrompt: "custom codex system",
      prependSystemContext: "pre system",
      appendSystemContext: "post system",
      prependContext: "queued context",
      appendContext: "tail context",
      toolsAllow: ["*"],
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", handler: beforePromptBuild },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const { params, manager } = await createHistory("openai");
    params.prompt = "hello";
    manager.appendMessage(assistantMessage("previous turn", Date.now()));
    const harness = createStartedThreadHarness();
    params.inputProvenance = { kind: "inter_session", sourceTool: "sessions_send" };
    (params.config ??= {}).agents = { defaults: { model: { primary: "openai/gpt-5.5" } } };
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    // The first build fixes thread instructions; a new-thread continuity projection
    // rebuilds only turn input after the actual startup lifecycle is known.
    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    const [hookInput, hookContext] = mockCall(beforePromptBuild, "before_prompt_build");
    const firstHookInput = requireRecord(hookInput, "hook input");
    expect(firstHookInput.prompt).toBe("hello");
    expect(firstHookInput.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "previous turn" }],
      }),
    ]);
    for (const [event] of beforePromptBuild.mock.calls) {
      expect(event).toMatchObject({ currentUserMessage: "hello" });
    }
    const lastHookInput = requireRecord(
      mockCall(beforePromptBuild, "before_prompt_build", 1)[0],
      "hook input",
    );
    expect(lastHookInput.prompt).toMatch(
      /\[assistant\]\nprevious turn[\s\S]*<\/conversation_context>\n\nCurrent user request:\nhello$/,
    );
    expect(lastHookInput.prompt).not.toMatch(/queued context|tail context/);
    assert(typeof lastHookInput.prompt === "string");
    const expectedInput = `queued context\n\n${lastHookInput.prompt}\n\ntail context`;
    expect(hookContext).toMatchObject({
      runId: "run-1",
      sessionId: params.sessionId,
      modelProviderId: params.provider,
      modelId: params.modelId,
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    const wrappedPluginSystemContext = (text: string) =>
      `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
    expect(requestParams(harness, "thread/start").developerInstructions).toContain(
      `custom codex system\n\n${wrappedPluginSystemContext("pre system")}\n\n${wrappedPluginSystemContext("post system")}`,
    );
    expect(requestParams(harness, "turn/start").input).toEqual([
      { type: "text", text: expectedInput, text_elements: [] },
    ]);
    expect(mockCall(llmInput, "llm_input")[0]).toMatchObject({
      prompt: expectedInput,
      historyMessages: [],
    });
  });
});
