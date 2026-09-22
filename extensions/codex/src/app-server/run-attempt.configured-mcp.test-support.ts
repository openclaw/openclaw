import path from "node:path";
import { createPluginMetadataSnapshotFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, vi } from "vitest";
import { createCronAuthorityCapabilityFixture } from "./codex-app-server.test-fixtures.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

const mcpMocks = vi.hoisted(() => ({
  authorityResolvers: [] as Array<
    (options?: { signal?: AbortSignal }) => Promise<{
      tools: readonly (string | { name: string; pluginId?: string })[];
      provenance: { version: 1; source: "final-executable-surface" };
    }>
  >,
  captureCalls: [] as Array<{
    sourceNames: string[];
    storedNames: string[];
    provenance?: unknown;
  }>,
  captureRefs: [] as Array<{
    value?: { version: 1; source: "final-executable-surface" };
  }>,
  dispose: vi.fn(async () => undefined),
  captureFacade: vi.fn(),
  staticFacade: vi.fn(),
  threadConfigFacade: vi.fn(),
  requesterCalls: 0,
  requesterCollisionTool: false,
  requesterDispose: vi.fn(async () => undefined),
  requesterParams: [] as Array<Record<string, unknown>>,
  useRealStaticMcp: false,
  staticDiagnosticNotice: undefined as string | undefined,
  staticFailure: undefined as Error | undefined,
  staticFailureGate: undefined as Promise<void> | undefined,
  staticCalls: [] as Array<Record<string, unknown>>,
  staticToolExecutes: [] as ReturnType<typeof vi.fn>[],
  threadConfigCalls: [] as Array<Record<string, unknown>>,
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
      mcpMocks.threadConfigCalls.push(params);
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
    runWithCronCreatorAuthorityCapabilityResolver: (
      params: Parameters<typeof actual.runWithCronCreatorAuthorityCapabilityResolver>[0],
    ) => {
      if (
        params.capability?.active !== true ||
        !params.runId ||
        params.capability.runId !== params.runId
      ) {
        return actual.runWithCronCreatorAuthorityCapabilityResolver(params as never);
      }
      mcpMocks.authorityResolvers.push(params.resolve);
      return actual.runWithCronCreatorAuthorityCapabilityResolver(params as never);
    },
    materializeStaticMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeStaticMcpToolsForHarnessRun>
    ) => {
      const params = args[0];
      mcpMocks.staticCalls.push(params);
      mcpMocks.staticFacade(params);
      if (mcpMocks.useRealStaticMcp) {
        return actual.materializeStaticMcpToolsForHarnessRun({
          ...params,
          retireSessionRuntimeAfterDispose: true,
        });
      }
      if (mcpMocks.staticFailure) {
        await mcpMocks.staticFailureGate;
        throw mcpMocks.staticFailure;
      }
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "initial-result" }],
        details: { status: "ok" },
      }));
      mcpMocks.staticToolExecutes.push(execute);
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
    captureFinalCodexCronCreatorToolAllowlist: async (
      ...args: Parameters<typeof actual.captureFinalCodexCronCreatorToolAllowlist>
    ) => {
      const [target, captureRef, tools] = args;
      mcpMocks.captureRefs.push(captureRef);
      mcpMocks.captureFacade(target, captureRef, tools);
      if (mcpMocks.useRealStaticMcp) {
        await actual.captureFinalCodexCronCreatorToolAllowlist(...args);
      } else {
        target.length = 0;
        for (const tool of tools) {
          if (
            !target.some((entry) => (typeof entry === "string" ? entry : entry.name) === tool.name)
          ) {
            target.push({ name: tool.name });
          }
        }
        captureRef.value = { version: 1, source: "final-executable-surface" };
      }
      mcpMocks.captureCalls.push({
        sourceNames: tools.map((tool) => tool.name).toSorted(),
        storedNames: target
          .map((entry) => (typeof entry === "string" ? entry : entry.name))
          .toSorted(),
        provenance: captureRef.value,
      });
    },
  };
});

export function setupConfiguredMcpTestHooks() {
  setupRunAttemptTestHooks();
  beforeEach(() => {
    mcpMocks.authorityResolvers.length = 0;
    mcpMocks.captureCalls.length = 0;
    mcpMocks.captureRefs.length = 0;
    mcpMocks.staticCalls.length = 0;
    mcpMocks.staticToolExecutes.length = 0;
    mcpMocks.requesterCalls = 0;
    mcpMocks.requesterCollisionTool = false;
    mcpMocks.requesterParams.length = 0;
    mcpMocks.useRealStaticMcp = false;
    mcpMocks.threadConfigCalls.length = 0;
    mcpMocks.staticDiagnosticNotice = undefined;
    mcpMocks.staticFailure = undefined;
    mcpMocks.staticFailureGate = undefined;
    mcpMocks.dispose.mockClear();
    mcpMocks.requesterDispose.mockClear();
    mcpMocks.captureFacade.mockClear();
    mcpMocks.staticFacade.mockClear();
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
  return metadataSnapshot;
}

export function admitLocalOperatorCronAuthority(params: ReturnType<typeof createParams>): void {
  params.cronCreatorAuthorityCapability = createCronAuthorityCapabilityFixture(params.runId);
}
