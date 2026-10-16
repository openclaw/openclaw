import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import { applyCodeModeCatalog } from "../../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../../code-mode.test-support.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { createCoreCodingTools } from "../../core-coding-tools.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";

const { createFixture } = await vi.hoisted(
  async () => await import("./attempt-execution-phase.test-support.js"),
);
import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await resetCodeModeTestState();
  vi.clearAllMocks();
});
const model: Model = {
  id: "fixture-model",
  name: "Fixture",
  api: "openai-responses",
  provider: "fixture-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1_000,
};

async function prepare() {
  const fixture = await createFixture({ exerciseTerminalMerges: false });
  const root = await fs.realpath(tempDirs.make("attempt-scoped-instructions-"));
  await fs.mkdir(path.join(root, "subsystem"));
  await fs.writeFile(
    path.join(root, "subsystem/AGENTS.md"),
    "Fixture subsystem rule: preserve the public interface.",
  );
  const delivery = fixture.input.prepared.toolBase.scopedInstructionDelivery;
  const coreTools = createCoreCodingTools({
    codingRoot: root,
    containmentRoot: root,
    includeBaseCodingTools: true,
    shellTools: "disabled",
    workspaceOnly: true,
    readOnly: false,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
  });
  const config = { tools: { codeMode: false, toolSearch: { enabled: false } } };
  const toolSurfaceRuntime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    modelToolsEnabled: true,
    executeTool: async () => {
      throw new Error("Unexpected compacted tool dispatch");
    },
  });
  onTestFinished(() => toolSurfaceRuntime.cleanup());
  const toolBase = fixture.input.prepared.toolBase;
  Object.assign(toolBase, {
    toolSurfaceRuntime,
    runtimeCapabilityProfile: resolveConversationCapabilityProfile({
      config,
      workspaceDir: root,
      cwd: root,
      agentId: "main",
    }),
    codeModeControlsEnabledForRun: false,
    codeModeSkills: [],
    localModelLeanPreserveToolNames: [],
    toolSearchConfig: toolSurfaceRuntime.plan.toolSearchConfig,
    toolSearchControlsEnabledForRun: false,
    toolsEnabled: true,
  });
  Object.assign(fixture.input.attempt, {
    config,
    model,
    modelId: model.id,
    provider: model.provider,
  });
  const setup = createAttemptSetupFixture({
    effectiveCwd: root,
    effectiveWorkspace: root,
    resolvedWorkspace: root,
    sessionPermissionRoot: root,
    getProviderRuntimeHandle: () => ({
      provider: model.provider,
      modelId: model.id,
      prepared: true,
    }),
  });
  Object.assign(fixture.input.setup, setup);
  fixture.input.prepared.toolCatalog = await prepareEmbeddedAttemptToolCatalog({
    attempt: fixture.input.attempt,
    setup,
    preparedToolBase: toolBase,
    bundleTools: {
      clientTools: undefined,
      uncompactedEffectiveTools: finalizeAgentTools({ tools: coreTools, hookContext: {} }),
    },
    abortSignal: fixture.input.runAbortController.signal,
    executeCodeModeTool: async () => {
      throw new Error("Unexpected compacted tool dispatch");
    },
  });
  const tools = fixture.input.prepared.toolCatalog.effectiveTools;
  return { ...fixture, root, tools, delivery, target: path.join(root, "subsystem/result.txt") };
}

describe("embedded attempt scoped instructions", () => {
  it.each([
    { operation: "write", codeMode: false },
    { operation: "write", codeMode: true },
    { operation: "read", codeMode: false },
    { operation: "read", codeMode: true },
    { operation: "ls", codeMode: false },
    { operation: "ls", codeMode: true },
  ])(
    "delivers guidance alongside $operation via automatic continuation (Code Mode: $codeMode)",
    async ({ operation, codeMode }) => {
      const fixture = await prepare();
      const mutation = operation === "write";
      const args = {
        path: operation === "ls" ? "subsystem" : "subsystem/result.txt",
        ...(mutation ? { content: "fresh decision" } : {}),
      };
      if (!mutation) {
        await fs.writeFile(fixture.target, "existing data");
      }
      const harness = codeMode ? createCodeModeHarness() : undefined;
      const tools = harness ? harness.tools : fixture.tools;
      if (harness) {
        applyCodeModeCatalog({
          tools: [...tools, ...fixture.tools],
          config: harness.config,
          catalogRef: harness.catalogRef,
        });
      }
      const contexts: Context[] = [];
      const targetPresentAtDecision: boolean[] = [];
      const { session, sessionManager } = await createTestSession({
        model,
        customTools: toToolDefinitions(tools),
      });
      const agent = session.agent;
      agent.streamFn = (_model, context) => {
        const index = contexts.length;
        contexts.push(context);
        targetPresentAtDecision.push(existsSync(fixture.target));
        if (index === 1) {
          // The provider, not the tool program, receives the complete guide before deciding again.
          expect(JSON.stringify(context.messages.at(-1))).toContain(
            "Fixture subsystem rule: preserve the public interface.",
          );
          expect(JSON.stringify(context.messages.at(-1))).toContain(
            "Continue automatically without asking the user",
          );
          const result = context.messages.find((message) => message.role === "toolResult");
          expect(result).toMatchObject({ isError: false });
          if (!mutation) {
            expect(JSON.stringify(result)).toContain(
              operation === "read" ? "existing data" : "result.txt",
            );
          }
        }
        const program =
          mutation && index === 0
            ? "for (let i = 0; i < 2; i++) { try { await write(" +
              JSON.stringify(args) +
              '); } catch {} } return "discarded tool diagnostics";'
            : "return await " + operation + "(" + JSON.stringify(args) + ");";
        const useTool = index === 0 || (mutation && index === 1);
        const content: AssistantMessage["content"] = useTool
          ? [
              {
                type: "toolCall",
                id: "fixture-call-" + index,
                name: codeMode ? "exec" : operation,
                arguments: codeMode ? { title: "Apply fixture edit", code: program } : args,
              },
            ]
          : [{ type: "text", text: "done" }];
        const message: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: createZeroUsageFixture(),
          stopReason: useTool ? "toolUse" : "stop",
          timestamp: index,
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: useTool ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      };
      agent.beforeToolCall = async () => {
        if (mutation && contexts.length === 2) {
          await expect(fs.stat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
        }
      };
      const runtime = fixture.input.prepared.sessionRuntime;
      Object.assign(fixture.input.attempt, { model, modelId: model.id, provider: model.provider });
      Object.assign(runtime, {
        anthropicPayloadLogger: undefined,
        cacheTrace: undefined,
        isOpenAIResponsesApi: false,
      });
      runtime.agentSession.activeSession = session;
      const names = new Set(tools.map((tool) => tool.name));
      Object.assign(fixture.input.prepared.toolCatalog.toolSearchRunPlan, {
        liveAllowedToolNames: names,
        replayAllowedToolNames: names,
        capabilityToolNames: new Set(fixture.tools.map((tool) => tool.name)),
      });
      await runEmbeddedAttemptExecutionPhase(fixture.input);
      const { installEmbeddedAttemptStreamGuards } =
        await vi.importActual<typeof import("./attempt-stream.js")>("./attempt-stream.js");
      installEmbeddedAttemptStreamGuards(fixture.input, {
        onRejectedProviderReplayRepaired: vi.fn(),
        onIdleTimeout: vi.fn(),
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({
          runId: fixture.input.attempt.runId,
          sessionId: fixture.input.attempt.sessionId,
        }),
      });
      await session.prompt("Update the fixture subsystem.");
      expect(targetPresentAtDecision).toEqual(mutation ? [false, false, true] : [true, true]);
      expect(JSON.stringify(contexts[1]?.messages)).toContain(
        "Fixture subsystem rule: preserve the public interface.",
      );
      expect(contexts).toHaveLength(mutation ? 3 : 2);
      expect(await fs.readFile(fixture.target, "utf8")).toBe(
        mutation ? "fresh decision" : "existing data",
      );
      expect(JSON.stringify(sessionManager.buildSessionContext().messages)).toContain(
        "Fixture subsystem rule",
      );
      if (mutation) {
        expect(contexts[2]?.messages.slice(0, contexts[1]!.messages.length)).toEqual(
          contexts[1]?.messages,
        );
      }
    },
  );

  it("does not auto-read guides excluded by the current prompt capability cap", async () => {
    const fixture = await prepare();
    const write = fixture.tools.find((tool) => tool.name === "write")!;
    const plan = fixture.input.prepared.toolCatalog.toolSearchRunPlan;
    plan.capabilityToolNames = new Set(["write"]);
    const messages: string[] = [];
    vi.spyOn(
      fixture.input.prepared.sessionRuntime.agentSession.activeSession,
      "sendCustomMessage",
    ).mockImplementation(async (message) => {
      messages.push(JSON.stringify(message.content));
    });
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const result = await write.execute("capped", {
      path: "subsystem/result.txt",
      content: "allowed write",
    });
    expect(await fs.readFile(fixture.target, "utf8")).toBe("allowed write");
    expect(JSON.stringify(result)).toContain("No complete delivery is claimed");
    expect(messages.join("\n")).not.toContain("Fixture subsystem rule");
  });

  it("invalidates delivered guides through the production compaction replacement hook", async () => {
    const fixture = await prepare();
    const write = fixture.tools.find((tool) => tool.name === "write")!;
    const args = { path: "subsystem/result.txt", content: "data" };
    fixture.input.prepared.toolCatalog.toolSearchRunPlan.capabilityToolNames = new Set([
      "read",
      "write",
    ]);
    const messages: AgentMessage[] = [];
    vi.spyOn(
      fixture.input.prepared.sessionRuntime.agentSession.activeSession,
      "sendCustomMessage",
    ).mockImplementation(async (message) => {
      messages.push({ role: "user", content: message.content, timestamp: 1 });
    });
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    await expect(write.execute("before", args)).resolves.toMatchObject({
      details: { status: "not_executed" },
    });
    fixture.delivery.observeMessages(messages);
    const replace = fixture.setContextReplacementHook.mock.calls[0]?.[0];
    expect(replace).toBeTypeOf("function");
    replace(100);
    await expect(write.execute("after", args)).resolves.toMatchObject({
      details: { status: "not_executed" },
    });
    await expect(fs.stat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
