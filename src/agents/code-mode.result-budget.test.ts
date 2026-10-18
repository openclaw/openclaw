import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOpenClawReadTool,
  createSandboxedReadTool,
  wrapReadToolWithSkillContent,
} from "./agent-tools.read.js";
import {
  expectCodeModeSharedBudget,
  expectCompleted,
  expectFailure,
  expectOriginalCodeModeMarker,
  fakeTool,
  resetCodeModeTestState,
  resultDetails,
  resultText as text,
} from "./code-mode.test-support.js";
import { submitEmbeddedAttemptPrompt } from "./embedded-agent-runner/run/attempt-prompt-submit.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
} from "./embedded-agent-runner/session-prompt-state.js";
import { installToolResultContextGuard } from "./embedded-agent-runner/tool-result-context-guard.js";
import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";
import { truncateOversizedToolResultsInMessages } from "./embedded-agent-runner/tool-result-truncation.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { Agent, type AgentMessage, type AgentToolResult } from "./runtime/index.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { agentSessionQueuePromptContext } from "./sessions/agent-session-prompting.js";
import { SessionManager } from "./sessions/session-manager.js";
import { createReadTool } from "./sessions/tools/read.js";
import type { ReadToolContinuation } from "./sessions/tools/tool-contracts.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { resolveLiveToolResultMaxChars } from "./tool-result-limits.js";
import type { AnyAgentTool } from "./tools/common.js";

const sessionId = "result-budget-boundary";
const contextWindow = 128_000;
const model = makeProviderModelFixture({
  id: "budget-fixture",
  name: "Budget fixture",
  provider: "test-provider",
  api: "openai-responses",
  baseUrl: "https://example.test",
  contextWindow,
  maxTokens: 1_000,
  compat: {},
});

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type BudgetOptions = { value?: { text: string }; fail?: boolean; context?: number };
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function message(
  result: AgentToolResult<unknown> | string,
  toolName: string,
  toolCallId = toolName,
): ToolResultMessage {
  return {
    ...(typeof result === "string"
      ? { content: [{ type: "text" as const, text: result }], details: {} }
      : result),
    role: "toolResult",
    toolName,
    toolCallId,
    isError: false,
    timestamp: 1,
  };
}

async function execute(tool: AnyAgentTool, id: string, args: unknown, callId = tool.name) {
  return message(await tool.execute(id, args), tool.name, callId);
}

function toolResult(messages: AgentMessage[], index: number): ToolResultMessage {
  const result = messages[index];
  if (result?.role !== "toolResult") {
    throw new Error("Expected a tool result at the model boundary");
  }
  return result;
}

async function dispatch(
  messages: AgentMessage[],
  contextWindowTokens = contextWindow,
): Promise<AgentMessage[]> {
  let sent: AgentMessage[] = [];
  const agent = new Agent({
    initialState: { model, messages },
    streamFn: (_model, context) => {
      sent = context.messages;
      return createAssistantMessageEventStream();
    },
  });
  const cleanup = installToolResultContextGuard({ agent, contextWindowTokens });
  const activeSession = {
    isCompacting: false,
    [agentSessionQueuePromptContext]: () => {
      throw new Error("Unexpected prompt context in the result-budget probe");
    },
    agent,
    get messages() {
      return agent.state.messages;
    },
  };
  using promptStateLease = retainEmbeddedSessionPromptState(sessionId);
  try {
    await submitEmbeddedAttemptPrompt({
      attempt: { sessionId },
      activeSession,
      contextTokenBudget: contextWindowTokens,
      images: [],
      modelPrompt: "",
      transcriptPrompt: "",
      systemPrompt: "",
      runtimeOnly: true,
      toolResultMaxChars: resolveLiveToolResultMaxChars({ contextWindowTokens }),
      toolResultAggregateMaxChars: 128_000,
      toolResultPromptProjectionState: promptStateLease.state.toolResults,
      trajectoryRecorder: null,
      transcriptLeafId: null,
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      persistToolResultProjections: async () => {},
      promptActiveSession: async () => {
        const context = await agent.transformContext!(messages, new AbortController().signal);
        await agent.streamFn(model, { messages: await agent.convertToLlm(context) });
      },
    });
    return sent;
  } finally {
    cleanup();
  }
}

afterEach(async () => {
  await resetCodeModeTestState();
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("fresh producer results through persistence and model guards", () => {
  it.each<[string, string, string, BudgetOptions]>([
    ["mixed encoded text", '🦞中a\u0001"\\\n'.repeat(6000), "é€".repeat(18000), {}],
    ["large final value", "é".repeat(15_000), "", { value: { text: "🦞".repeat(12_000) } }],
    ["long failure", "x".repeat(35_000), "é".repeat(9000), { fail: true }],
    ["effective raw-weight context", "é".repeat(6000), "é".repeat(6000), { context: 8000 }],
  ])(
    "keeps %s Code Mode output complete after yield and provider dispatch",
    async (_name, firstText, lastText, options) =>
      withOpenClawTestState({ label: "code-mode-result-budget" }, async (state) => {
        const cap = 65536;
        const { context = contextWindow, fail = false, value = true } = options;
        const runtime = createAgentHarnessToolSurfaceRuntimeCore({
          config: { tools: { codeMode: { enabled: true, maxOutputBytes: cap } } },
          model,
          contextTokenBudget: context,
          modelToolsEnabled: true,
          sessionId,
          executeTool: async () => {
            throw new Error("This fixture has no catalog tools");
          },
        });
        try {
          const tools = runtime.compactTools([]).tools;
          if (runtime.toolSearchCatalogRef?.current) {
            runtime.toolSearchCatalogRef.current.counterScope = "result-budget";
          }
          const first = await execute(tools[0]!, "first", {
            code: `text(${JSON.stringify(firstText)}); await yield_control(); await yield_control(); ${lastText ? `text(${JSON.stringify(lastText)});` : ""} ${fail ? 'throw new Error("DIAGNOSTIC" + "é".repeat(40000));' : `return ${JSON.stringify(value)};`}`,
          });
          const runId = resultDetails(first).runId;
          const firstSent = text(toolResult(await dispatch([first], context), 0));
          expect(JSON.parse(firstSent)).toMatchObject({ status: "waiting", runId });
          const empty = await execute(tools[1]!, "empty", { runId }, "empty");
          expect(resultDetails(empty)).toMatchObject({ status: "waiting", output: [] });
          const final = await execute(tools[1]!, "second", { runId });
          const sent = await dispatch([first, empty, final], context);
          expect(text(toolResult(sent, 0))).toBe(firstSent);
          const finalText = text(toolResult(sent, 2));
          expect(JSON.parse(finalText)).toMatchObject({ status: fail ? "failed" : "completed" });
          const original = [
            { type: "text", text: firstText },
            ...(lastText ? [{ type: "text", text: lastText }] : []),
          ];
          const details = resultDetails(final);
          const output = details.output as unknown[];
          if (output.length > 0) {
            expectOriginalCodeModeMarker(output[0], original);
          } else {
            expect(lastText).toBe("");
            expect(jsonBytes(original) + jsonBytes(details.value)).toBeLessThanOrEqual(cap);
          }
          if (fail) {
            expectFailure(details, "guest", "internal_error", {
              bridgeDispatchStarted: true,
              error: expect.stringMatching(/^Error: DIAGNOSTIC.*\[error truncated\]$/s),
            });
          } else if (value === true) {
            expect(details.value).toEqual(value);
          } else {
            expect(details.value).toMatchObject({
              truncated: true,
              reference: { id: expect.any(String), bytes: jsonBytes(value) },
            });
            const reference = (details.value as { reference: { id: string } }).reference;
            const loaded = resultDetails(
              await tools[0]!.execute("retained", {
                code: `return (await results.load(${JSON.stringify(reference.id)})).text.length;`,
              }),
            );
            expectCompleted(loaded, value.text.length);
          }

          const scope = {
            agentId: "main",
            sessionId,
            sessionKey: "agent:main:result-budget",
            storePath: join(state.sessionsDir(), "sessions.json"),
          };
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
          const manager = SessionManager.open(scope, state.workspaceDir);
          const maxChars = resolveLiveToolResultMaxChars({ contextWindowTokens: context });
          installSessionToolResultGuard(manager, { maxToolResultChars: maxChars });
          for (const [index, frame] of [first, empty, final].entries()) {
            const frameText = text(frame);
            expect(text(toolResult(sent, index)), "unchanged producer text").toBe(frameText);
            expect(estimateToolResultTextChars(frameText)).toBeLessThanOrEqual(maxChars);
            const rawWeight = estimateToolResultTextChars(frameText, { minimumRawWeight: 2 });
            expect(rawWeight).toBeLessThanOrEqual(context);
            expectCodeModeSharedBudget(resultDetails(frame), cap);
            manager.appendMessage(frame);
          }
          manager.flushPendingPersistence();
          const reloaded = SessionManager.open(scope, state.workspaceDir).buildSessionContext()
            .messages;
          expect(text(toolResult(reloaded, 2))).toBe(finalText);
          expect(text(toolResult(await dispatch(reloaded, context), 2))).toBe(finalText);
        } finally {
          runtime.cleanup();
        }
      }),
  );

  it.each([
    ["host ASCII", false, "0123456789".repeat(12_000), 128_000],
    ["sandbox resolved filename", true, "中é🦞0123456789".repeat(18_000), 128_000],
    ["effective raw-weight context", false, "é".repeat(16_000), 8000],
  ] as const)(
    "keeps the read owner's exact cursor through the downstream result guard: %s",
    async (_name, sandbox, source, context) =>
      withOpenClawTestState({ label: "read-result-budget" }, async (state) => {
        const file = join(state.workspaceDir, sandbox ? "notes 3.04 PM.txt" : "long-line.txt");
        await writeFile(sandbox ? file.replace(" PM", "\u202fPM") : file, source);
        const read = sandbox
          ? createSandboxedReadTool({
              root: state.workspaceDir,
              bridge: createHostSandboxFsBridge(state.workspaceDir),
              modelContextWindowTokens: context,
            })
          : createOpenClawReadTool(createReadTool(state.workspaceDir), {
              modelContextWindowTokens: context,
              cwd: state.workspaceDir,
            });
        let collected = "";
        let continuation: ReadToolContinuation | undefined;
        for (let index = 0; index < 16; index++) {
          const callId = `read-${index}`;
          const page = await execute(read, callId, { path: file, ...continuation }, callId);
          const sent = toolResult(await dispatch([page], context), 0);
          expect(text(sent), "read bytes must not be clipped").toBe(text(page));
          continuation = resultDetails(page).continuation as ReadToolContinuation | undefined;
          const pageText = sandbox ? text(sent).slice(text(sent).indexOf("\n") + 1) : text(sent);
          if (!continuation) {
            collected += pageText;
            break;
          }
          expect(continuation.kind).toBe("cursor");
          const chunk = pageText.slice(0, pageText.lastIndexOf("\n\n["));
          expect(chunk.length).toBeGreaterThan(0);
          collected += chunk;
          expect(text(sent)).toContain(`cursor=${collected.length}`);
          expect(collected).toBe(source.slice(0, collected.length));
        }
        expect(collected).toBe(source);
      }),
  );

  it("preserves wrapped network result structure and terminal batches", async () => {
    const network = fakeTool("network_fixture", "Read a network fixture");
    network.resultContentSource = "network";
    network.execute = async () => ({
      content: [{ type: "text", text: "received" }],
      details: "received",
      terminate: true,
    });
    const runtime = createAgentHarnessToolSurfaceRuntimeCore({
      config: { tools: { codeMode: true } },
      model,
      modelToolsEnabled: true,
      sessionId,
      executeTool: async ({ toolCallId, input }) => network.execute(toolCallId, input),
    });
    try {
      const [exec, wait] = runtime.compactTools([network]).tools;
      const first = await exec!.execute("network", {
        code: `await network_fixture({}); text('<s>'.repeat(20000)); await yield_control(); return "é".repeat(20000);`,
      });
      expect(first.terminate).not.toBe(true);
      const final = await wait!.execute("network-wait", { runId: resultDetails(first).runId });
      expect(final.terminate).toBe(true);
      for (const result of [first, final]) {
        const rendered = text(result);
        expect(rendered).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
        expect(rendered).not.toContain("\n[truncated]");
        const body = rendered.split("\n---\n")[1]?.split("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT")[0];
        expect(body!.length).toBeLessThanOrEqual(20_000);
        expect(JSON.parse(body!)).toMatchObject({ status: resultDetails(result).status });
        expect(text(toolResult(await dispatch([message(result, "exec")]), 0))).toBe(rendered);
      }
    } finally {
      runtime.cleanup();
    }
  });

  it("preserves conventional plain text and mixed MCP content without inferring JSON", async () => {
    const plain = message('{"unfinished": shell output', "shell");
    const mcp = message(
      projectMcpCallToolResult({
        structuredContent: { ok: false },
        isError: true,
        content: [
          { type: "text", text: "Retry with a narrower query." },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      }),
      "mcp",
    );
    const sent = await dispatch([plain, mcp]);
    expect(toolResult(sent, 0).content).toEqual(plain.content);
    expect(toolResult(sent, 1).content).toEqual(mcp.content);
    expect(text(mcp)).toContain("structuredContent:\n");
    expect(text(mcp)).toContain("Retry with a narrower query.");
  });

  it("allows explicitly lossy aggregate reduction and smaller-context replay", () => {
    const original = message(
      JSON.stringify({ status: "completed", value: "x".repeat(20_000) }),
      "exec",
    );
    const aggregate = truncateOversizedToolResultsInMessages(
      [original, { ...original, toolCallId: "second" }],
      128_000,
      32_000,
      32_000,
    );
    expect(aggregate.aggregateTruncatedCount).toBe(1);
    expect(text(toolResult(aggregate.messages, 0))).not.toBe(text(original));
    const smaller = truncateOversizedToolResultsInMessages([original], 8000);
    expect(() => JSON.parse(text(toolResult(smaller.messages, 0)))).toThrow();
    expect(() => JSON.parse(text(original))).not.toThrow();
  });

  it("refuses a whole skill that fits the byte cap but exceeds the model text budget", async () => {
    const locator = "node://fixture/skills/whole/SKILL.md";
    const base = createReadTool("/");
    const read = wrapReadToolWithSkillContent(
      base,
      [{ filePath: locator, readContent: "INSTRUCTIONS" + "中".repeat(9000) }],
      { modelContextWindowTokens: contextWindow },
    );
    const result = await read.execute("skill", { path: locator, offset: 2, limit: 1 });
    expect(text(result)).toContain("cannot be partially served");
    expect(text(result)).not.toContain("INSTRUCTIONS");
  });
});
