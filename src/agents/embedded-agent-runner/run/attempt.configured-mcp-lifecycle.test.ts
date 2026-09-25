import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import type { SessionMcpRuntime } from "../../agent-bundle-mcp-types.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { wrapToolDefinitions } from "../../sessions/tools/tool-definition-wrapper.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
  type EmbeddedAttemptSession,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
let runtime: SessionMcpRuntime;

// The shared harness skips session adaptation and bundled tools by default.
// Restore those owners; only the MCP transport is replaced by a held response.
beforeAll(async () => {
  vi.doUnmock("../tool-split.js");
  vi.doUnmock("../../agent-tools.js");
  vi.doUnmock("../../tool-fs-policy.js");
  vi.doUnmock("../../model-auth.js");
  vi.doMock("../../agent-bundle-mcp-tools.js", async () => {
    const materialize = await import("../../agent-bundle-mcp-materialize.js");
    return {
      ...materialize,
      acquireSessionMcpRuntime: async () => ({ runtime, releaseLease: () => {} }),
      retireSessionMcpRuntime: async () => true,
    };
  });
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => resetEmbeddedAttemptHarness());
afterEach(async () => cleanupTempPaths(tempPaths));

describe("runEmbeddedAttempt configured MCP lifecycle (agents-embedded-agent-run)", () => {
  it.each([false, true])(
    "delivers the result with one lifecycle, cataloged=%s",
    async (cataloged) => {
      const started = createDeferred();
      const finish = createDeferred();
      const marker = "configured-mcp-result";
      const toolName = "silent__delayed_local";
      const runId = `configured-mcp-${cataloged}`;
      const sessionKey = "agent:main:main";
      const events: DiagnosticEventPayload[] = [];
      const requests: AgentMessage[][] = [];
      const catalog = {
        version: 1,
        generatedAt: 0,
        servers: {
          silent: { serverName: "silent", launchSummary: "local fixture", toolCount: 1 },
        },
        tools: [
          {
            serverName: "silent",
            safeServerName: "silent",
            toolName: "delayed_local",
            description: "Return a delayed result",
            fallbackDescription: "Return a delayed result",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
      runtime = {
        sessionId: "embedded-session",
        workspaceDir: "unused",
        configFingerprint: "fixture",
        createdAt: 0,
        lastUsedAt: 0,
        markUsed: () => {},
        getCatalog: async () => catalog,
        peekCatalog: () => catalog,
        callTool: async () => {
          started.resolve();
          await finish.promise;
          return { content: [{ type: "text", text: marker }] };
        },
        joinCleanup: async () => {},
        dispose: async () => {},
      };
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (
          (event.type === "tool.execution.started" ||
            event.type === "tool.execution.completed" ||
            event.type === "tool.execution.error") &&
          event.toolName === toolName
        ) {
          events.push(event);
        }
      });
      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey,
        tempPaths,
        createSession: () => {
          const session: EmbeddedAttemptSession = createDefaultEmbeddedSession();
          const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0];
          if (!options?.model || !options.customTools) {
            throw new Error("The embedded runner did not prepare its session tools");
          }
          const model = options.model;
          const tools = wrapToolDefinitions(options.customTools);
          expect(tools.map((tool) => tool.name)).toContain(cataloged ? "tool_call" : toolName);
          if (cataloged) {
            expect(tools.map((tool) => tool.name)).not.toContain(toolName);
          }
          const agent = new Agent({
            initialState: { model, tools },
            streamFn: (_model, context) => {
              requests.push(structuredClone(context.messages));
              const first = requests.length === 1;
              const message: AssistantMessage = {
                role: "assistant",
                content: first
                  ? [
                      {
                        type: "toolCall",
                        id: "delayed-call",
                        name: cataloged ? "tool_call" : toolName,
                        arguments: cataloged ? { id: toolName, args: {} } : {},
                      },
                    ]
                  : [{ type: "text", text: marker }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: createZeroUsageFixture(),
                stopReason: first ? "toolUse" : "stop",
                timestamp: Date.now(),
              };
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
                stream.end();
              });
              return stream;
            },
          });
          session.agent = agent;
          Object.defineProperty(session, "messages", {
            get: () => agent.state.messages,
            set: (messages) => {
              agent.state.messages = messages;
            },
          });
          session.setActiveToolsByName = (names) => {
            agent.state.tools = tools.filter((tool) => names.includes(tool.name));
          };
          session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
          session.prompt = async (prompt, promptOptions) => {
            promptOptions?.preflightResult?.(true);
            await agent.prompt(prompt);
          };
          return session;
        },
        attemptOverrides: {
          runId,
          disableTools: false,
          sessionManager: SessionManager.inMemory(),
          toolsAllow: ["silent__*", "tool_search", "tool_call", "tool_describe"],
          config: {
            tools: {
              codeMode: false,
              toolSearch: cataloged ? { enabled: true, mode: "tools" } : false,
            },
            mcp: { servers: { silent: { command: "fixture", requestTimeoutMs: 900000 } } },
          },
        },
      });
      try {
        await Promise.race([
          started.promise,
          attempt.then(() => {
            throw new Error("Tool never started");
          }),
        ]);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(events).toEqual([
          expect.objectContaining({
            type: "tool.execution.started",
            runId,
            sessionId: "embedded-session",
            sessionKey,
            toolCallId: cataloged
              ? "tool_search_code:delayed-call:silent__delayed_local:1"
              : "delayed-call",
          }),
        ]);
        expect(requests).toHaveLength(1);
        finish.resolve();
        const result = await attempt;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(events.map((event) => event.type)).toEqual([
          "tool.execution.started",
          "tool.execution.completed",
        ]);
        expect(events[1]).toMatchObject({
          runId,
          sessionId: "embedded-session",
          sessionKey,
          toolCallId: cataloged
            ? "tool_search_code:delayed-call:silent__delayed_local:1"
            : "delayed-call",
        });
        expect(requests).toHaveLength(2);
        expect(requests[1]?.filter((message) => message.role === "toolResult")).toEqual([
          expect.objectContaining({
            toolCallId: "delayed-call",
            isError: false,
            content: [
              expect.objectContaining({ type: "text", text: expect.stringContaining(marker) }),
            ],
          }),
        ]);
        expect(result.messagesSnapshot.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: marker }],
        });
      } finally {
        finish.resolve();
        try {
          await attempt;
        } finally {
          unsubscribe();
        }
      }
    },
  );
});
