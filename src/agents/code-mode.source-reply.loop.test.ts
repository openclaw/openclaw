import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
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
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { readToolResultDetails } from "./tool-result-error.js";
import { jsonResult } from "./tools/common.js";
import { createMessageTool } from "./tools/message-tool-execution.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

describe("Code Mode explicit source-reply completion", () => {
  it.for([
    {
      name: "direct final",
      nested: false,
      held: false,
      final: true,
      lateInput: "none",
      recovery: "none",
    },
    {
      name: "nested final",
      nested: true,
      held: false,
      final: true,
      lateInput: "none",
      recovery: "none",
    },
    {
      name: "nested final with pending siblings",
      nested: true,
      held: true,
      final: true,
      lateInput: "none",
      recovery: "none",
    },
    {
      name: "nested progress with pending siblings",
      nested: true,
      held: true,
      final: false,
      lateInput: "none",
      recovery: "none",
    },
    {
      name: "nested final before late accepted input",
      nested: true,
      held: true,
      final: true,
      lateInput: "accepted",
      recovery: "none",
    },
    {
      name: "nested final before late cancelled input",
      nested: true,
      held: true,
      final: true,
      lateInput: "cancelled",
      recovery: "none",
    },
    {
      name: "nested final with same-input continuation after failed publication",
      nested: true,
      held: false,
      final: true,
      lateInput: "none",
      recovery: "same",
    },
    {
      name: "nested final with new input after failed publication",
      nested: true,
      held: false,
      final: true,
      lateInput: "none",
      recovery: "new",
    },
  ])("$name", async ({ name, nested, held, final, lateInput, recovery }, { signal }) => {
    await withStateDirEnv("openclaw-code-mode-final-", async ({ tempRoot }) => {
      const config = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const id = name.replaceAll(" ", "-");
      const scope = {
        agentId: "main",
        sessionId: `session-code-mode-${id}`,
        sessionKey: `agent:main:${id}`,
        storePath: resolveDefaultSessionStorePath("main"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope);
      manager.appendMessage({ role: "user", content: "Read and report the result", timestamp: 1 });
      const inputPath = join(tempRoot, "input.txt");
      await writeFile(inputPath, "verified input\n");
      const delivered = createDeferred();
      const innerStarted = createDeferred();
      const innerRelease = createDeferred();
      const outerStarted = createDeferred();
      const outerRelease = createDeferred();
      const parked = createDeferred();
      const waiting = createDeferred();
      const effects: string[] = [];
      const controls: Array<{ name: string; status: unknown; runId: unknown; terminate: unknown }> =
        [];
      const waitRunIds: unknown[] = [];
      let controlResult: unknown;
      let requests = 0;
      let continuationRequests = 0;
      let settled = false;
      let queuedLateInput = false;
      let publicationFailed = false;
      let recoveryProbeSent = false;
      const publicationError = new Error("tool result publication failed");
      const nextInput = {
        role: "user" as const,
        content: "Input B needs its own answer.",
        timestamp: 2,
      };
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
            (message) =>
              message.role === "toolResult" &&
              (message.toolName === "exec" || message.toolName === "wait"),
          );
          const pending = readToolResultDetails(lastResult);
          let content: AssistantMessage["content"];
          if (requests === 1) {
            content = [
              {
                type: "toolCall",
                id: "source-call",
                name: nested ? "exec" : "message",
                arguments: nested
                  ? { title: "Read and reply", code }
                  : { action: "send", message: "RESULT: VERIFIED INPUT", final },
              },
              ...(held
                ? [
                    {
                      type: "toolCall" as const,
                      id: "outer-call",
                      name: "outer_sibling",
                      arguments: {},
                    },
                  ]
                : []),
            ];
          } else if (publicationFailed && !recoveryProbeSent) {
            recoveryProbeSent = true;
            content = [
              {
                type: "toolCall",
                id: "recovery-read",
                name: "read",
                arguments: { path: inputPath },
              },
            ];
          } else if (pending?.status === "waiting") {
            waiting.resolve();
            waitRunIds.push(pending.runId);
            content = [
              {
                type: "toolCall",
                id: `wait-${requests}`,
                name: "wait",
                arguments: { runId: pending.runId },
              },
            ];
          } else {
            continuationRequests += 1;
            content = [{ type: "text", text: "Automatic final after the tools." }];
          }
          const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
          const message: AssistantMessage = {
            role: "assistant",
            content,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason,
            timestamp: requests,
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "done", reason: stopReason, message });
            stream.end();
          });
          return stream;
        },
      });
      const harness = createSubscribedCodeModeHarness({ name: id, sessionManager: manager, agent });
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
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async () => ({
          resolvedConfig: config,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
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
      const inner = pluginToolWithExecute(
        "inner_sibling",
        "Settle a nested operation",
        async () => {
          innerStarted.resolve();
          await innerRelease.promise;
          effects.push("inner settled");
          return jsonResult({ settled: true });
        },
      );
      const outer = pluginToolWithExecute("outer_sibling", "Settle a batch operation", async () => {
        outerStarted.resolve();
        await outerRelease.promise;
        effects.push("outer settled");
        return jsonResult({ settled: true });
      });
      applyCodeModeCatalog({
        ...harness,
        tools: [...harness.tools, source, read, inner, outer],
      });
      agent.state.tools = nested
        ? [...harness.tools, source, outer, ...(recovery !== "none" ? [read] : [])]
        : [source];
      agent.afterToolCall = async ({ toolCall, result }) => {
        recordEmbeddedToolReceipt(
          manager,
          toolCall.id,
          result.details,
          toolCall.name === "message",
        );
        return undefined;
      };
      installMessageToolTerminalHook({ agent, sourceReplyDeliveryMode: "automatic" });
      agent.afterToolOutcome = async ({ toolCall, result }) => {
        if (toolCall.name !== "exec" && toolCall.name !== "wait") {
          return;
        }
        const details = readToolResultDetails(result);
        const status = details?.status;
        controlResult = result;
        controls.push({
          name: toolCall.name,
          status,
          runId: details?.runId,
          terminate: result.terminate,
        });
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
          (event.message.toolName === "exec" || event.message.toolName === "wait") &&
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
          // The completion hook has already run; only the later checkpoint can
          // adopt this input. Queue cancellation must leave A's authority intact.
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
            Promise.all([delivered.promise, innerStarted.promise, outerStarted.promise]),
          );
          // The guest explicitly yields with its nested operation still held;
          // reply delivery alone does not imply that a host wait timer is armed.
          await beforeSettlement(parked.promise);
          expect(controls).toEqual([
            { name: "exec", status: "waiting", runId: expect.any(String), terminate: undefined },
          ]);
          expect(settled).toBe(false);
          expect(effects).toEqual(["reply committed"]);
          outerRelease.resolve();
          await beforeSettlement(waiting.promise);
          expect(settled).toBe(false);
          expect(effects).toEqual(["reply committed", "outer settled"]);
          innerRelease.resolve();
        }
        await withinTest(running, signal);
        await withinTest(harness.subscription.waitForPendingEvents(), signal);
        expect(
          sourceSpy,
          JSON.stringify({
            controlResult,
            readCalls: readSpy.mock.calls.length,
            nestedActivities: await harness.readNestedActivities(),
          }),
        ).toHaveBeenCalledOnce();
        expect(readSpy).toHaveBeenCalledTimes((nested ? 1 : 0) + (recovery !== "none" ? 1 : 0));
        expect(controls.at(-1)?.status).toBe(nested ? "completed" : undefined);
        if (held) {
          expect(effects).toEqual(["reply committed", "outer settled", "inner settled"]);
        }
        const messages = SessionManager.open(scope)
          .getEntries()
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        expect(messages.filter((message) => message.role === "assistant")).toEqual([
          expect.objectContaining({ content: [{ type: "text", text: "RESULT: VERIFIED INPUT" }] }),
        ]);
        expect(messages[0]).toMatchObject({ role: "user", content: "Read and report the result" });
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
        innerRelease.resolve();
        outerRelease.resolve();
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
});
