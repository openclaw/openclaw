import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import { buildDynamicTools } from "./dynamic-tool-build.js";
import type { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { createCodexTestModel } from "./test-support.js";

const hoisted = vi.hoisted(() => ({
  normalizeAgentRuntimeTools: vi.fn(),
  resolveWebSearchToolPolicy: vi.fn(),
  loadNodeExecAvailability: vi.fn(),
}));

export { hoisted };

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>();

  return {
    ...actual,
    resolveWebSearchToolPolicy: (
      ...args: Parameters<(typeof actual)["resolveWebSearchToolPolicy"]>
    ) => {
      hoisted.resolveWebSearchToolPolicy(...args);
      return actual.resolveWebSearchToolPolicy(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    normalizeAgentRuntimeTools: (...args: Parameters<typeof actual.normalizeAgentRuntimeTools>) => {
      hoisted.normalizeAgentRuntimeTools(...args);
      return actual.normalizeAgentRuntimeTools(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/node-selection-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/node-selection-runtime")>();
  return { ...actual, loadNodeExecAvailability: hoisted.loadNodeExecAvailability };
});

export function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

export function createCodexRuntimePlanFixture(): NonNullable<
  EmbeddedRunAttemptParams["runtimePlan"]
> {
  return {
    auth: {},
    observability: {
      resolvedRef: "codex/gpt-5.4-codex",
      provider: "codex",
      modelId: "gpt-5.4-codex",
      harnessId: "codex",
    },
    prompt: {
      resolveSystemPromptContribution: () => undefined,
    },
    tools: {
      normalize: (tools: unknown[]) => tools,
      logDiagnostics: () => undefined,
    },
  } as unknown as NonNullable<EmbeddedRunAttemptParams["runtimePlan"]>;
}

export async function buildDynamicToolsForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  options: Partial<Parameters<typeof buildDynamicTools>[0]> = {},
) {
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  return buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sandboxSessionKey,
    sandbox: { enabled: false, backendId: "docker" } as never,
    ...(params.permissionMode && params.sessionRoot
      ? {
          sessionPermissionPolicy: {
            mode: params.permissionMode,
            root: params.sessionRoot,
            execMode:
              params.permissionMode === "read-only"
                ? "deny"
                : params.permissionMode === "guarded"
                  ? "ask"
                  : params.permissionMode === "workspace"
                    ? "auto"
                    : "full",
          },
        }
      : {}),
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? options.sessionAgentId ?? "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
    ...options,
  });
}

export async function bindProductionCodexHostCapabilities(
  params: EmbeddedRunAttemptParams,
  hostCapabilityClosers: Array<() => void>,
): Promise<void> {
  const { createAgentHarnessHostCapabilitiesForTest } =
    await import("openclaw/plugin-sdk/plugin-test-runtime");
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
  params.hostCapabilities = host.capabilities;
  hostCapabilityClosers.push(host.close);
}

export type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

export function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `${name} done` }],
      details: {},
    })),
  };
}
