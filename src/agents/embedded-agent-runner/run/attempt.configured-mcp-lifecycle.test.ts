import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import type { SessionMcpRuntime } from "../../agent-bundle-mcp-types.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  createAgentBackedAttemptSession,
  streamAttemptAssistant,
  attemptToolCall,
} from "./attempt-agent.test-support.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const tempPaths: string[] = [];
let runtime: SessionMcpRuntime;

// Restore harness-skipped tool owners; replace only the MCP transport.
beforeAll(async () => {
  vi.doUnmock("../../agent-tool-definition-adapter.js");
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

it.each([false, true])(
  "configured MCP delivers the result with one lifecycle, cataloged=%s",
  async (cataloged) => {
    const started = createDeferred();
    const finish = createDeferred();
    const marker = "configured-mcp-result";
    const toolName = "silent__delayed_local";
    const callable = cataloged ? "dispatch_action" : toolName;
    const args = cataloged ? { id: toolName, args: {} } : {};
    const call = attemptToolCall("delayed-call", callable, args);
    const finalContent = [{ type: "text" as const, text: marker }];
    const runId = `configured-mcp-${cataloged}`;
    const sessionKey = "agent:main:main";
    const eventIdentity = {
      runId,
      sessionId: "embedded-session",
      sessionKey,
      toolCallId: cataloged ? "tool_call:delayed-call:silent__delayed_local:1" : "delayed-call",
    };
    const startedEvent = { type: "tool.execution.started", ...eventIdentity };
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
      createSession: () =>
        createAgentBackedAttemptSession((model, tools) => {
          expect(tools.map((tool) => tool.name)).toContain(callable);
          if (cataloged) {
            expect(tools.map((tool) => tool.name)).not.toContain(toolName);
          }
          return new Agent({
            initialState: { model, tools },
            streamFn: (_model, context) => {
              requests.push(structuredClone(context.messages));
              return streamAttemptAssistant(model, requests.length === 1 ? call : finalContent);
            },
          });
        }),
      attemptOverrides: {
        runId,
        disableTools: false,
        sessionManager: SessionManager.inMemory(),
        toolsAllow: ["silent__*", "tool_search", "dispatch_action", "tool_describe"],
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
      await nextTurn();
      expect(events).toMatchObject([startedEvent]);
      expect(requests).toHaveLength(1);
      finish.resolve();
      const result = await attempt;
      await nextTurn();
      expect(events).toMatchObject([
        startedEvent,
        { type: "tool.execution.completed", ...eventIdentity },
      ]);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.filter((message) => message.role === "toolResult")).toMatchObject([
        {
          toolCallId: "delayed-call",
          isError: false,
          content: [{ type: "text", text: expect.stringContaining(marker) }],
        },
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
