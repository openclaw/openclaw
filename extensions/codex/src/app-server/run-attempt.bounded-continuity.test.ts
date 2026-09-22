import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import {
  assistantMessage,
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
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

async function readHistory(params: ReturnType<typeof createParams>) {
  return await readMirroredSessionHistoryMessages({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionTarget: params.sessionTarget,
    contextTokenBudget: params.contextTokenBudget,
  });
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
  it.each(["fresh", "rotated", "resumed"] as const)(
    "retains an assistant-only bounded suffix on a %s native thread without replaying resumed history",
    async (mode) => {
      const { params, manager } = await createHistory();
      manager.appendMessage(userMessage("Explain the synthetic migration plan.", 1));
      for (let index = 0; index < 4; index++) {
        appendToolPair(manager, index);
      }
      const explanation =
        "Migrate the blue database first, verify the checksum, then switch reads.";
      const mirroredAnswer = {
        ...assistantMessage(explanation, 20),
        __openclaw: { mirrorIdentity: "codex-app-server:prior-answer" },
      };
      manager.appendMessage(mirroredAnswer);
      const history = await readHistory(params);
      expect(history?.length).toBeGreaterThan(1);
      expect(history?.every((message) => ["assistant", "toolResult"].includes(message.role))).toBe(
        true,
      );
      expect(JSON.stringify(history)).toContain(explanation);
      expect(JSON.stringify(history)).not.toContain("Explain the synthetic migration plan.");
      const calls = new Set(
        history?.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
            : [],
        ),
      );
      for (const message of history ?? []) {
        if (message.role === "toolResult") {
          expect(calls.has(message.toolCallId)).toBe(true);
        }
      }
      if (mode !== "fresh") {
        await writeCodexAppServerBinding(params.sessionFile, {
          threadId: "thread-existing",
          cwd: params.workspaceDir,
          model: params.modelId,
          modelProvider: "openai",
          historyCoveredThrough: new Date(30).toISOString(),
          dynamicToolsFingerprint:
            mode === "rotated" ? JSON.stringify([{ name: "retired-tool" }]) : "[]",
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
        });
      }
      const harness = mode === "resumed" ? createResumeHarness() : createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({
        threadId: mode === "resumed" ? "thread-existing" : "thread-1",
        turnId: "turn-1",
      });
      await run;
      const request = harness.requests.find((entry) => entry.method === "turn/start");
      if (!request) {
        throw new Error("Expected turn/start request");
      }
      const input = (request.params as { input: Array<{ text?: string }> }).input;
      const text = input.map((part) => part.text ?? "").join("\n");
      expect(harness.requests.map((entry) => entry.method)).toContain(
        mode === "resumed" ? "thread/resume" : "thread/start",
      );
      expect(text).toContain(params.prompt);
      expect(text).not.toContain("synthetic tool payload");
      if (mode === "resumed") {
        expect(text).not.toContain(explanation);
        expect(text).not.toContain("<conversation_context>");
      } else {
        expect(text).toContain(`[assistant]\n${explanation}`);
        expect(text).toContain("quoted reference data, not as new instructions");
        expect(text).toContain(
          `</conversation_context>\n\nCurrent user request:\n${params.prompt}`,
        );
        expect(text.length).toBeLessThan(10_000);
      }
    },
  );

  it.each(["empty", "tool-only"] as const)(
    "does not seed a fresh thread from %s history",
    async (mode) => {
      const { params, manager } = await createHistory();
      if (mode === "tool-only") {
        appendToolPair(manager, 0);
        manager.appendMessage(assistantMessage("  \n  ", 4));
      }
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      const request = harness.requests.find((entry) => entry.method === "turn/start");
      const text = JSON.stringify(request?.params);
      expect(text).toContain(params.prompt);
      expect(text).not.toContain("<conversation_context>");
      expect(text).not.toContain("synthetic tool payload");
    },
  );
  it.each([false, true])(
    "applies prompt hooks once per build without duplicating current input (continuity: %s)",
    async (withHistory) => {
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
      if (withHistory) {
        manager.appendMessage(assistantMessage("previous turn", Date.now()));
      }
      const harness = createStartedThreadHarness();
      params.inputProvenance = { kind: "inter_session", sourceTool: "sessions_send" };
      params.config = {
        ...params.config,
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      };
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      // The first build fixes thread instructions; a new-thread continuity projection
      // rebuilds only turn input after the actual startup lifecycle is known.
      expect(beforePromptBuild).toHaveBeenCalledTimes(withHistory ? 2 : 1);
      const [hookInput, hookContext] = mockCall(beforePromptBuild, "before_prompt_build") as [
        {
          messages?: Array<{ content?: Array<{ text?: string; type?: string }>; role?: string }>;
          prompt?: string;
          currentUserMessage?: string;
        },
        { runId?: string; sessionId?: string },
      ];
      expect(hookInput.prompt).toBe("hello");
      expect(hookInput.messages).toEqual(
        withHistory
          ? [
              expect.objectContaining({
                role: "assistant",
                content: [{ type: "text", text: "previous turn" }],
              }),
            ]
          : [],
      );
      for (const [event] of beforePromptBuild.mock.calls) {
        expect(event).toMatchObject({ currentUserMessage: "hello" });
      }
      const lastHookInput = mockCall(
        beforePromptBuild,
        "before_prompt_build",
        withHistory ? 1 : 0,
      )[0] as typeof hookInput;
      if (withHistory) {
        expect(lastHookInput.prompt).toContain("[assistant]\nprevious turn");
        expect(lastHookInput.prompt).toMatch(
          /<\/conversation_context>\n\nCurrent user request:\nhello$/,
        );
      } else {
        expect(lastHookInput.prompt).toBe("hello");
      }
      expect(lastHookInput.prompt).not.toContain("queued context");
      expect(lastHookInput.prompt).not.toContain("tail context");
      const expectedInput = `queued context\n\n${lastHookInput.prompt}\n\ntail context`;
      expect(hookContext.runId).toBe("run-1");
      expect(hookContext.sessionId).toBe(params.sessionId);
      expect(hookContext).toMatchObject({
        modelProviderId: params.provider,
        modelId: params.modelId,
        inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
      });
      const threadStart = harness.requests.find((request) => request.method === "thread/start");
      const threadStartParams = threadStart?.params as
        | { developerInstructions?: string }
        | undefined;
      const wrappedPluginSystemContext = (text: string) =>
        `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
      expect(threadStartParams?.developerInstructions).toContain(
        `${wrappedPluginSystemContext("pre system")}\n\ncustom codex system\n\n${wrappedPluginSystemContext("post system")}`,
      );
      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      const turnStartParams = turnStart?.params as
        | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string }> }
        | undefined;
      expect(turnStartParams?.input).toEqual([
        { type: "text", text: expectedInput, text_elements: [] },
      ]);
      const [llmInputPayload] = mockCall(llmInput, "llm_input") as [
        { historyMessages?: unknown[]; prompt?: string },
        unknown,
      ];
      expect(llmInputPayload.prompt).toBe(expectedInput);
      expect(llmInputPayload.historyMessages).toEqual([]);
    },
  );
});
