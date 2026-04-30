import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultEmbeddedSession,
  getHoisted,
  resetEmbeddedAttemptHarness,
  testModel,
} from "./attempt.spawn-workspace.test-support.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const mockModel = testModel as unknown as Model<Api>;

const mockTool = {
  name: "mock_tool",
  label: "Mock Tool",
  description: "mock",
  parameters: { type: "object" as const, properties: {} },
  execute: async () => ({ content: [{ type: "text" as const, text: "Aborted" }], details: {} }),
};

function createToolUseStreamFn(tracker: { count: number }) {
  return async (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
    tracker.count += 1;
    await sleep(5);
    if (options?.signal?.aborted) {
      const err = new Error("Request was aborted.");
      err.name = "AbortError";
      throw err;
    }
    const message = {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: `call_${tracker.count}`,
          name: "mock_tool",
          arguments: {},
        },
      ],
      usage: {
        input: 70,
        output: 51,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 121,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    };
    return {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (!done) {
              done = true;
              return { done: false, value: { type: "done", message } };
            }
            return { done: true, value: undefined };
          },
        };
      },
      async result() {
        return message;
      },
    } as never;
  };
}

function createImmediateStopStreamFn() {
  return async () => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "done" }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    return {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (!done) {
              done = true;
              return { done: false, value: { type: "done", message } };
            }
            return { done: true, value: undefined };
          },
        };
      },
      async result() {
        return message;
      },
    } as never;
  };
}

const hoisted = getHoisted();

const agentsToCleanUp: Agent[] = [];

describe("abort-before-prompt guard (fix for zombie Agent loop)", () => {
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    for (const agent of agentsToCleanUp) {
      agent.abort();
      agent.clearAllQueues?.();
      await agent.waitForIdle();
    }
    agentsToCleanUp.length = 0;
  });

  it(
    "fix: pre-aborted signal skips prompt(), no LLM calls after attempt exits",
    { timeout: 10_000 },
    async () => {
      const tracker = { count: 0 };

      const agent = new Agent({
        initialState: { systemPrompt: "test", model: mockModel, tools: [mockTool] },
        streamFn: createToolUseStreamFn(tracker),
        convertToLlm: (msgs: AgentMessage[]): Message[] =>
          msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[],
      });
      agentsToCleanUp.push(agent);

      hoisted.createAgentSessionMock.mockResolvedValue({
        session: createDefaultEmbeddedSession({
          prompt: async (_session, prompt) => {
            agent.prompt(prompt).catch(() => {});
            await sleep(50);
          },
        }),
      });

      const abortSignal = AbortSignal.abort(new Error("second message arrived"));
      const { runEmbeddedAttempt } = await import("./attempt.js");

      await runEmbeddedAttempt({
        sessionId: "abort-guard-test",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/abort-guard-test.jsonl",
        workspaceDir: "/tmp",
        agentDir: "/tmp",
        config: {},
        prompt: "first message",
        timeoutMs: 5_000,
        runId: "abort-guard-run",
        provider: "openai",
        modelId: "gpt-test",
        model: mockModel,
        authStorage: { getApiKey: async () => undefined } as never,
        modelRegistry: {} as never,
        thinkLevel: "off",
        senderIsOwner: true,
        disableMessageTool: true,
        abortSignal,
      });

      const countAtExit = tracker.count;
      await sleep(500);
      const countAfterWait = tracker.count;

      expect(countAtExit).toBe(0);
      expect(countAfterWait).toBe(0);
    },
  );

  it(
    "normal completion is unaffected: prompt() runs and LLM is called when signal is not aborted",
    { timeout: 10_000 },
    async () => {
      let promptCalled = false;

      const agent = new Agent({
        initialState: { systemPrompt: "test", model: mockModel, tools: [] },
        streamFn: createImmediateStopStreamFn(),
        convertToLlm: (msgs: AgentMessage[]): Message[] =>
          msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[],
      });
      agentsToCleanUp.push(agent);

      hoisted.createAgentSessionMock.mockResolvedValue({
        session: createDefaultEmbeddedSession({
          prompt: async (_session, prompt) => {
            promptCalled = true;
            await agent.prompt(prompt);
          },
        }),
      });

      const { runEmbeddedAttempt } = await import("./attempt.js");

      await runEmbeddedAttempt({
        sessionId: "normal-run-test",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/normal-run-test.jsonl",
        workspaceDir: "/tmp",
        agentDir: "/tmp",
        config: {},
        prompt: "hello",
        timeoutMs: 5_000,
        runId: "normal-run",
        provider: "openai",
        modelId: "gpt-test",
        model: mockModel,
        authStorage: { getApiKey: async () => undefined } as never,
        modelRegistry: {} as never,
        thinkLevel: "off",
        senderIsOwner: true,
        disableMessageTool: true,
      });

      expect(promptCalled).toBe(true);
    },
  );

  it(
    "fix: abort during preflight triggers agent.abort() via abortable() onAbort, terminates before LLM call",
    { timeout: 10_000 },
    async () => {
      const tracker = { count: 0 };
      const agent = new Agent({
        initialState: { systemPrompt: "test", model: mockModel, tools: [mockTool] },
        streamFn: createToolUseStreamFn(tracker),
        convertToLlm: (msgs: AgentMessage[]): Message[] =>
          msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)) as Message[],
      });

      agentsToCleanUp.push(agent);

      let agentPromptStarted = false;
      const session = createDefaultEmbeddedSession({
        prompt: async (_session, prompt) => {
          // fire agent.prompt() (creates activeRun inside runWithLifecycle)
          agent.prompt(prompt).catch(() => {});
          agentPromptStarted = true;
          // hold the session open so abortable() is still racing when abort fires
          await sleep(200);
        },
      });
      // Wire the real Agent into the session mock so activeSession.agent.abort()
      // in abortable()'s onAbort handler reaches the actual Agent instance.
      session.agent.abort = () => agent.abort();
      session.agent.clearAllQueues = () => agent.clearAllQueues?.();
      session.abort = async () => {
        agent.abort();
      };
      hoisted.createAgentSessionMock.mockResolvedValue({ session });

      const abortController = new AbortController();
      const { runEmbeddedAttempt } = await import("./attempt.js");

      const runPromise = runEmbeddedAttempt({
        sessionId: "preflight-abort-test",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/preflight-abort-test.jsonl",
        workspaceDir: "/tmp",
        agentDir: "/tmp",
        config: {},
        prompt: "first message",
        timeoutMs: 5_000,
        runId: "preflight-abort-run",
        provider: "openai",
        modelId: "gpt-test",
        model: mockModel,
        authStorage: { getApiKey: async () => undefined } as never,
        modelRegistry: {} as never,
        thinkLevel: "off",
        senderIsOwner: true,
        disableMessageTool: true,
        abortSignal: abortController.signal,
      });

      // Wait until agent.prompt() has been called (activeRun now exists),
      // then abort — this is the window the abortable() onAbort handler covers.
      await sleep(30);
      expect(agentPromptStarted).toBe(true);
      abortController.abort(new Error("second message arrived after agent.prompt() started"));

      await runPromise;

      const countAtExit = tracker.count;
      await sleep(300);
      const countAfterWait = tracker.count;

      // abortable() onAbort called agent.abort() while activeRun existed,
      // so the loop stops quickly and no new LLM calls are made after attempt exits.
      expect(countAfterWait).toBe(countAtExit);
    },
  );
});
