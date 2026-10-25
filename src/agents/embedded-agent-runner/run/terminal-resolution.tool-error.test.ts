import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../../../packages/agent-core/src/agent.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createReplyDispatcher } from "../../../auto-reply/reply/reply-dispatcher.js";
import { classifyAgentExecResult } from "../../../commands/agent-exec-result.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import {
  resolveEmbeddedRunTerminal,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

// mock-isolation: auth bookkeeping is unrelated to the terminal delivery contract.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

describe("terminal tool failures", () => {
  it.each([false, true])(
    "propagates a real subscribed tool failure (blocked=%s)",
    async (blocked) => {
      const execute = vi.fn(async () => {
        throw new Error("Synthetic execution failure");
      });
      const read = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "File contents" }],
        details: {},
      }));
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "terminal-failure" });
      let requests = 0;
      const agent = new Agent({
        initialState: {
          model: {
            id: "terminal-test",
            name: "Terminal test",
            api: "openai-responses",
            provider: "test-provider",
            baseUrl: "https://example.test",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 1000,
          },
          tools: [
            {
              name: "exec",
              label: "exec",
              description: "Executes a step",
              parameters: Type.Object({}),
              execute,
            },
            {
              name: "read",
              label: "read",
              description: "Reads a file",
              parameters: Type.Object({}),
              execute: read,
            },
          ],
        },
        beforeToolCall: async ({ toolCall }) =>
          blocked && toolCall.name === "exec"
            ? { block: true, reason: "Synthetic denial" }
            : undefined,
        streamFn: () => {
          const first = requests++ === 0;
          const message = makeAgentAssistantMessage({
            content: first
              ? [
                  { type: "text", text: "I will run the command and read the file." },
                  { type: "toolCall", id: "exec-failure", name: "exec", arguments: {} },
                  { type: "toolCall", id: "read-success", name: "read", arguments: {} },
                ]
              : [],
            stopReason: first ? "toolUse" : "stop",
          });
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
          stream.end();
          return stream;
        },
      });
      const unsubscribe = agent.subscribe(emit);
      try {
        await agent.prompt("Run the command and read the file.");
        await subscription.waitForPendingEvents();
        expect(execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
        expect(read).toHaveBeenCalledTimes(1);
        expect(requests).toBe(2);
        expect(subscription.getLastToolError()).toMatchObject({
          toolName: "exec",
          executionStarted: !blocked,
        });
        const assistant = subscription.getCurrentAttemptAssistant();
        const input = makeTerminalInput({
          attemptAssistant: assistant,
          attempt: makeEmbeddedRunnerAttempt({
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            assistantTexts: subscription.assistantTexts,
            toolMetas: subscription.toolMetas,
            lastToolError: subscription.getLastToolError(),
            itemLifecycle: subscription.getItemLifecycle(),
            messagesSnapshot: agent.state.messages,
          }),
        });
        input.prepared = await prepareAttempt({
          attempt: input.attempt,
          currentAttemptCompletedAssistant: assistant,
          terminalState: input.terminalState,
        });
        const warning = input.prepared.payloads?.find((payload) => payload.isError)?.text;
        expect(warning).toContain(blocked ? "blocked" : "failed");
        const result = await resolveEmbeddedRunTerminal(input);
        expect(result.action).toBe("complete");
        if (result.action !== "complete") {
          throw new Error("expected completion");
        }
        expect(result.result.meta.error).toMatchObject({
          kind: "incomplete_turn",
          message: warning,
        });
        expect(result.result.payloads).toEqual([
          expect.objectContaining({ text: warning, isError: true }),
        ]);
        expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
        // These are the real execution and provider boundaries, not delivery counts.
        expect(execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
        expect(read).toHaveBeenCalledTimes(1);
        expect(requests).toBe(2);
      } finally {
        unsubscribe();
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { output: "native", denialFirst: true },
    { output: "native", denialFirst: false },
    { output: "commentary" },
    { output: "toolUse" },
    { output: "delegated" },
    { output: "visible" },
    { output: "silent" },
  ])(
    "delivers the terminal denied-exec outcome (output=$output, denialFirst=$denialFirst)",
    async ({ output, denialFirst = true }) => {
      const commentary = output === "commentary" ? "I will check the command and file." : undefined;
      const toolCalls = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          ...(commentary ? [{ type: "text" as const, text: commentary }] : []),
          { type: "toolCall", id: "denied", name: "bash", arguments: {} },
          { type: "toolCall", id: "sibling", name: "read", arguments: {} },
        ],
      });
      const answered = output === "visible" || output === "silent";
      const answerText =
        output === "silent"
          ? "NO_REPLY"
          : "The command was denied; the file was read successfully.";
      const assistant = answered
        ? buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: answerText }] })
        : commentary
          ? buildEmbeddedRunnerAssistant({ content: [] })
          : output === "toolUse"
            ? toolCalls
            : undefined;
      const input = makeTerminalInput({
        attemptAssistant: assistant,
        attempt: makeEmbeddedRunnerAttempt({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          assistantTexts: answered ? [answerText] : commentary ? [commentary] : [],
          agentHarnessResultClassification: output === "native" ? "empty" : undefined,
          acceptedSessionSpawns:
            output === "delegated"
              ? [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }]
              : undefined,
          lastToolError: {
            toolName: "bash",
            error: "codex native tool blocked",
            executionStarted: false,
            mutatingAction: false,
          },
          toolMetas: [
            { toolName: "bash", toolCallId: "denied", isError: true, replaySafe: true },
            { toolName: "read", toolCallId: "sibling", isError: false, replaySafe: true },
          ],
          itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
          messagesSnapshot: [
            { role: "user", content: "Run the command and read the file.", timestamp: 0 },
            toolCalls,
            ...(denialFirst
              ? [
                  makeTextToolResult("denied", "bash", "Execution denied.", true, 0),
                  makeTextToolResult("sibling", "read", "File contents.", false, 0),
                ]
              : [
                  makeTextToolResult("sibling", "read", "File contents.", false, 0),
                  makeTextToolResult("denied", "bash", "Execution denied.", true, 0),
                ]),
            ...(assistant && (answered || commentary) ? [assistant] : []),
          ],
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        }),
      });
      input.prepared = await prepareAttempt({
        attempt: input.attempt,
        currentAttemptCompletedAssistant: assistant,
        terminalState: input.terminalState,
      });

      const failureWarningText = input.prepared.payloads?.find((payload) => payload.isError)?.text;
      if (output === "native" || output === "commentary") {
        expect(
          resolveSettledTurnFinalizationRequest({
            ...input,
            payloadsWithToolMedia: input.prepared.payloadsWithToolMedia,
            hasTerminalToolPresentation: false,
            settledTurnFinalizationAvailable: true,
            replyDeliveryState: input.prepared.replyDeliveryState,
          }),
        ).toBeNull();
      }
      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("expected terminal completion");
      }
      const deliver = vi.fn(async () => {});
      const dispatcher = createReplyDispatcher({ deliver });
      for (const payload of resolved.result.payloads ?? []) {
        dispatcher.sendFinalReply(payload);
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
      expect(classifyAgentExecResult(resolved.result).status).toBe(answered ? "ok" : "error");
      if (answered) {
        expect(resolved.result.meta.error).toBeUndefined();
        if (output === "silent") {
          expect(resolved.result.payloads).toBeUndefined();
          expect(deliver).not.toHaveBeenCalled();
        } else {
          expect(resolved.result.payloads?.map((payload) => payload.text)).toEqual([answerText]);
          expect(deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ text: answerText }),
            { kind: "final" },
          );
        }
      } else {
        expect(failureWarningText).toContain("blocked");
        expect(resolved.result.payloads).toHaveLength(1);
        expect(deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: failureWarningText, isError: true }),
          { kind: "final" },
        );
        if (output === "delegated") {
          expect(resolved.result.meta.error).toBeUndefined();
        } else {
          expect(resolved.result.meta.error).toMatchObject({
            kind: "incomplete_turn",
            message: failureWarningText,
          });
          expect(resolved.result.meta.stopReason).toBe("error");
        }
      }
    },
  );
});
