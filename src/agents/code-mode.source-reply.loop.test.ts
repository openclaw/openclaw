import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  pluginToolWithExecute,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";
import { installMessageToolTerminalHook } from "./embedded-agent-runner/run/message-tool-terminal.js";
import { recordEmbeddedToolReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import { Agent } from "./runtime/index.js";
import { SessionManager } from "./sessions/session-manager.js";
import { createReadTool } from "./sessions/tools/read.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { readToolResultDetails } from "./tool-result-error.js";
import { jsonResult } from "./tools/common.js";
import { createMessageTool } from "./tools/message-tool-execution.js";

const model = makeProviderModelFixture({
  id: "test-model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  contextWindow: 1_000,
  maxTokens: 1_000,
});

function call(id: string, name: string, args: Record<string, unknown>) {
  return [{ type: "toolCall" as const, id, name, arguments: args }];
}
const isControl = (name: string) => name === "exec" || name === "wait";

it.for([
  { name: "direct final", nested: false },
  { name: "nested final" },
  { name: "nested final with pending siblings", held: true },
  { name: "nested progress with pending siblings", held: true, final: false },
  { name: "late accepted input", held: true, lateInput: "accepted" },
  { name: "late cancelled input", held: true, lateInput: "cancelled" },
  { name: "same-input publication recovery", recovery: "same" },
  { name: "new-input publication recovery", recovery: "new" },
])("Code Mode explicit source-reply completion: $name", async (scenario, { signal }) => {
  const {
    name: scenarioName,
    nested = true,
    held = false,
    final = true,
    lateInput = "none",
    recovery = "none",
  } = scenario;
  await withStateDirEnv("openclaw-code-mode-final-", async ({ tempRoot }) => {
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const id = scenarioName.replaceAll(" ", "-");
    const scope = {
      agentId: "main",
      sessionId: `session-code-mode-${id}`,
      sessionKey: `agent:main:${id}`,
      storePath: resolveDefaultSessionStorePath("main"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope);
    const question = "Read and report the result";
    const answer = "RESULT: VERIFIED INPUT";
    manager.appendMessage(makeAgentUserMessage({ content: question, timestamp: 1 }));
    const inputPath = join(tempRoot, "input.txt");
    await writeFile(inputPath, "verified input\n");
    const delivered = createDeferred();
    const parked = createDeferred();
    const waiting = createDeferred();
    const effects: string[] = [];
    const controls: Array<{
      name: string;
      status: unknown;
      runId: unknown;
      terminate: unknown;
    }> = [];
    const waitRunIds: unknown[] = [];
    let requests = 0;
    let continuationRequests = 0;
    let settled = false;
    let queuedLateInput = false;
    let publicationFailed = false;
    let recoveryProbeSent = false;
    const publicationError = new Error("tool result publication failed");
    const nextInput = makeAgentUserMessage({ content: "Answer input B.", timestamp: 2 });
    const code = [
      `const input = await read({ path: ${JSON.stringify(inputPath)} });`,
      ...(held ? ["const sibling = inner_sibling({});"] : []),
      `await message({ action: "send", message: "RESULT: " + input.content.trim().toUpperCase(), final: ${final} });`,
      ...(held ? ["await yield_control();", "await sibling;"] : []),
      'return "cell settled";',
    ].join("\n");
    const agent = new Agent({
      initialState: { model },
      streamFn: (_model, context) => {
        requests += 1;
        const lastResult = context.messages.findLast(
          (message) => message.role === "toolResult" && isControl(message.toolName),
        );
        const pending = readToolResultDetails(lastResult);
        let content: AssistantMessage["content"];
        if (requests === 1) {
          content = [
            ...call(
              "source-call",
              nested ? "exec" : "message",
              nested
                ? { title: "Read and reply", code }
                : { action: "send", message: answer, final },
            ),
            ...(held ? call("outer-call", "outer_sibling", {}) : []),
          ];
        } else if (publicationFailed && !recoveryProbeSent) {
          recoveryProbeSent = true;
          content = call("recovery-read", "read", { path: inputPath });
        } else if (pending?.status === "waiting") {
          waiting.resolve();
          waitRunIds.push(pending.runId);
          content = call(`wait-${requests}`, "wait", { runId: pending.runId });
        } else {
          continuationRequests += 1;
          content = [{ type: "text", text: "Automatic final after the tools." }];
        }
        const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
        const message = makeAgentAssistantMessage({
          content,
          provider: model.provider,
          stopReason,
          timestamp: requests,
        });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: stopReason, message });
          stream.end();
        });
        return stream;
      },
    });
    const harness = createSubscribedCodeModeHarness({
      name: id,
      sessionManager: manager,
      agent,
    });
    const source = createMessageTool({
      config,
      preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "automatic",
      agentSessionKey: scope.sessionKey,
      runSessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      runId: harness.runId,
    });
    const executeSource = source.execute;
    const sourceSpy = vi.spyOn(source, "execute").mockImplementation(async (...args) => {
      const result = await executeSource(...args);
      effects.push("reply committed");
      delivered.resolve();
      return result;
    });
    const read = createReadTool(tempRoot);
    const readSpy = vi.spyOn(read, "execute");
    function sibling(siblingName: string) {
      const started = createDeferred();
      const release = createDeferred();
      const tool = pluginToolWithExecute(`${siblingName}_sibling`, "Settle", async () => {
        started.resolve();
        await release.promise;
        effects.push(`${siblingName} settled`);
        return jsonResult({ settled: true });
      });
      return { tool, started, release };
    }
    const inner = sibling("inner");
    const outer = sibling("outer");
    applyCodeModeCatalog({
      ...harness,
      tools: [...harness.tools, source, read, inner.tool, outer.tool],
    });
    agent.state.tools = nested
      ? [...harness.tools, source, outer.tool, ...(recovery !== "none" ? [read] : [])]
      : [source];
    agent.afterToolCall = async ({ toolCall, result }) => {
      recordEmbeddedToolReceipt(manager, toolCall.id, result.details, toolCall.name === "message");
    };
    installMessageToolTerminalHook({ agent, sourceReplyDeliveryMode: "automatic" });
    agent.afterToolOutcome = async ({ toolCall: { name }, result }) => {
      if (!isControl(name)) {
        return;
      }
      const { status, runId } = readToolResultDetails(result) ?? {};
      controls.push({ name, status, runId, terminate: result.terminate });
      if (status === "waiting") {
        parked.resolve();
      }
    };
    const unsubscribe = agent.subscribe(async (event) => {
      harness.emit(event);
      if (
        recovery !== "none" &&
        !publicationFailed &&
        event.type === "message_end" &&
        event.message.role === "toolResult" &&
        isControl(event.message.toolName) &&
        readToolResultDetails(event.message)?.status === "completed"
      ) {
        publicationFailed = true;
        throw publicationError;
      }
      if (
        lateInput !== "none" &&
        !queuedLateInput &&
        event.type === "turn_end" &&
        event.toolResults.some((result) => readToolResultDetails(result)?.status === "waiting")
      ) {
        // Only the post-completion checkpoint adopts this input; cancellation retains A's authority.
        agent.steer(nextInput);
        queuedLateInput = true;
        if (lateInput === "cancelled") {
          expect(agent.cancelSteeringMessage((message) => message === nextInput)).toBe(nextInput);
        }
      }
    });
    const running = (async () => {
      await agent.prompt("Read the file and reply through the message tool.");
      if (recovery !== "none") {
        expect(agent.state.errorMessage).toBe(publicationError.message);
        if (recovery === "new") {
          await agent.prompt(nextInput);
        } else {
          await agent.continue();
        }
      }
    })().finally(() => {
      settled = true;
    });
    const beforeSettlement = async (event: Promise<unknown>) =>
      await withinTest(
        awaitGateBeforeSettlement(event, running, "Agent settled before the held operation"),
        signal,
      );
    try {
      if (held) {
        await beforeSettlement(
          Promise.all([delivered.promise, inner.started.promise, outer.started.promise]),
        );
        // Guest yield parks a live sibling; delivery alone does not arm a host wait timer.
        await beforeSettlement(parked.promise);
        expect(controls).toEqual([
          { name: "exec", status: "waiting", runId: expect.any(String), terminate: undefined },
        ]);
        expect(settled).toBe(false);
        expect(effects).toEqual(["reply committed"]);
        outer.release.resolve();
        await beforeSettlement(waiting.promise);
        expect(settled).toBe(false);
        expect(effects).toEqual(["reply committed", "outer settled"]);
        inner.release.resolve();
      }
      await withinTest(running, signal);
      await withinTest(harness.subscription.waitForPendingEvents(), signal);
      expect(sourceSpy).toHaveBeenCalledOnce();
      expect(readSpy).toHaveBeenCalledTimes((nested ? 1 : 0) + (recovery !== "none" ? 1 : 0));
      expect(controls.at(-1)?.status).toBe(nested ? "completed" : undefined);
      if (held) {
        expect(effects).toEqual(["reply committed", "outer settled", "inner settled"]);
      }
      const messages = SessionManager.open(scope)
        .getEntries()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
      expect(messages.filter((message) => message.role === "assistant")).toEqual([
        expect.objectContaining({ content: [{ type: "text", text: answer }] }),
      ]);
      expect(messages[0]).toMatchObject({ role: "user", content: question });
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
      expect(waitRunIds).toHaveLength(Math.max(0, controls.length - 1));
      for (let index = 1; index < controls.length; index++) {
        const previous = controls[index - 1];
        expect(previous).toMatchObject({ status: "waiting", runId: expect.any(String) });
        expect(controls[index]?.name).toBe("wait");
        expect(waitRunIds[index - 1]).toBe(previous?.runId);
      }
      expect(queuedLateInput).toBe(lateInput !== "none");
      expect(publicationFailed).toBe(recovery !== "none");
      expect(recoveryProbeSent).toBe(recovery !== "none");
      expect(agent.state.messages.includes(nextInput)).toBe(
        lateInput === "accepted" || recovery === "new",
      );
      expect(continuationRequests).toBe(
        final && lateInput !== "accepted" && recovery !== "new" ? 0 : 1,
      );
    } finally {
      inner.release.resolve();
      outer.release.resolve();
      agent.abort();
      try {
        await running;
      } finally {
        try {
          await resetCodeModeTestState();
        } finally {
          unsubscribe();
          harness.dispose();
          vi.restoreAllMocks();
          clearRuntimeConfigSnapshot();
        }
      }
    }
  });
});
