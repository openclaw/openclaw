import path from "node:path";
import { createPluginMetadataSnapshotFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, vi } from "vitest";
import {
  createParams,
  createCodexRuntimePlanFixture,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

const mcpMocks = vi.hoisted(() => ({
  dispose: vi.fn(async () => undefined),
  threadConfigFacade: vi.fn(),
  requesterCalls: 0,
  requesterCollisionTool: false,
  requesterDispose: vi.fn(async () => undefined),
  requesterParams: [] as Array<Record<string, unknown>>,
  staticDiagnosticNotice: undefined as string | undefined,
  staticFailure: undefined as Error | undefined,
  staticCalls: [] as Array<Record<string, unknown>>,
}));

export { mcpMocks };

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      mcpMocks.requesterCalls += 1;
      const params = args[0] as Record<string, unknown>;
      mcpMocks.requesterParams.push(params);
      if (!mcpMocks.requesterCollisionTool) {
        return undefined;
      }
      const reserved = new Set(params.reservedToolNames as string[] | undefined);
      const name = reserved.has("fake__show") ? "fake__show_2" : "fake__show";
      const tool = {
        name,
        description: "Requester-scoped MCP collision fixture.",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "scoped" }] })),
      };
      return {
        tools: [tool],
        advertisedTools: [tool],
        dispose: mcpMocks.requesterDispose,
      };
    },
    loadCodexBundleMcpThreadConfig: async (
      ...args: Parameters<typeof actual.loadCodexBundleMcpThreadConfig>
    ) => {
      const params = args[0] as Record<string, unknown>;
      const override = mcpMocks.threadConfigFacade(params);
      if (override) {
        return override;
      }
      const cfg = params.cfg as
        | { mcp?: { servers?: Record<string, Record<string, unknown>> } }
        | undefined;
      const configuredServers = cfg?.mcp?.servers ?? {};
      const staticServerNames = Object.keys(configuredServers).toSorted();
      return {
        configPatch: staticServerNames.length > 0 ? { mcp_servers: configuredServers } : undefined,
        diagnostics: [],
        evaluated: true,
        fingerprint: staticServerNames.length > 0 ? "configured-mcp-test-fixture" : undefined,
        staticServerNames,
        userStaticServerNames: staticServerNames,
      };
    },
  };
});

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/codex-mcp-projection")>();
  return {
    ...actual,
    materializeStaticMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeStaticMcpToolsForHarnessRun>
    ) => {
      const params = args[0];
      mcpMocks.staticCalls.push(params);
      if (mcpMocks.staticFailure) {
        throw mcpMocks.staticFailure;
      }
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "initial-result" }],
        details: { status: "ok" },
      }));
      return {
        tools: mcpMocks.staticDiagnosticNotice
          ? []
          : [
              {
                name: "fake__show",
                description: "Show the configured MCP fixture result.",
                parameters: { type: "object", properties: {} },
                execute,
              },
            ],
        appTools: [
          {
            name: "fake__app_only",
            description: "App-view-only configured MCP fixture.",
            parameters: { type: "object", properties: {} },
            execute,
          },
        ],
        ...(mcpMocks.staticDiagnosticNotice
          ? { diagnosticNotice: mcpMocks.staticDiagnosticNotice }
          : {}),
        dispose: mcpMocks.dispose,
      };
    },
  };
});

export function setupConfiguredMcpTestHooks() {
  setupRunAttemptTestHooks();
  beforeEach(() => {
    mcpMocks.staticCalls.length = 0;
    mcpMocks.requesterCalls = 0;
    mcpMocks.requesterCollisionTool = false;
    mcpMocks.requesterParams.length = 0;
    mcpMocks.staticDiagnosticNotice = undefined;
    mcpMocks.staticFailure = undefined;
    mcpMocks.dispose.mockClear();
    mcpMocks.requesterDispose.mockClear();
    mcpMocks.threadConfigFacade.mockClear();
  });
}

export function configureFakeMcp(params: ReturnType<typeof createParams>) {
  setCodexTestModelSupportsTools(params, true);
  params.cleanupBundleMcpOnRunEnd = true;
  params.runtimePlan = createCodexRuntimePlanFixture();
  const metadataSnapshot = createPluginMetadataSnapshotFixture();
  params.preparedModelRuntime = { metadataSnapshot } as never;
  params.config = {
    ...params.config,
    mcp: {
      servers: {
        fake: {
          command: process.execPath,
          args: [path.resolve("scripts/e2e/mcp-app-conformance-server.mjs")],
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      },
    },
  };
}
