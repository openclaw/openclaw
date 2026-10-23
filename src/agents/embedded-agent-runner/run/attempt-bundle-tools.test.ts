import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../../config/plugin-auto-enable.test-helpers.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { attachToolAllowlistIntersection } from "../../tool-policy.js";
import { listPersistedRuntimeToolSchemaQuarantines } from "../../tool-schema-quarantine-health.js";
import { withRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";

const mocks = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
  acquireSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
  applyFinalEffectiveToolPolicy: vi.fn(),
  filterRuntimeCompatibleTools: vi.fn(),
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: mocks.createBundleLspToolRuntime,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
  materializeBundleMcpToolsForRun: mocks.materializeBundleMcpToolsForRun,
}));

vi.mock("../../runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: vi.fn(({ tools }: { tools: unknown[] }) => [...tools]),
}));

vi.mock("../../local-model-lean.js", () => ({
  filterLocalModelLeanTools: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));

vi.mock("../../tool-schema-projection.js", () => ({
  filterRuntimeCompatibleTools: mocks.filterRuntimeCompatibleTools,
}));

vi.mock("../effective-tool-policy.js", () => ({
  applyFinalEffectiveToolPolicy: mocks.applyFinalEffectiveToolPolicy,
}));

import { prepareEmbeddedAttemptBundleTools as prepare } from "./attempt-bundle-tools.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";

describe("prepareEmbeddedAttemptBundleTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBundleLspToolRuntime.mockReset().mockResolvedValue(undefined);
    mocks.acquireSessionMcpRuntime.mockReset().mockResolvedValue(undefined);
    mocks.materializeBundleMcpToolsForRun.mockReset().mockResolvedValue(undefined);
    mocks.applyFinalEffectiveToolPolicy
      .mockReset()
      .mockImplementation(({ bundledTools }: { bundledTools: unknown[] }) => bundledTools);
    mocks.filterRuntimeCompatibleTools
      .mockReset()
      .mockImplementation((tools: unknown[]) => ({ tools, diagnostics: [] }));
  });

  function createInput(inheritedToolAllowlist: string[] = [], toolsRaw: unknown[] = []) {
    return {
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        model: {},
        modelId: "model",
        provider: "provider",
        runId: "run",
        runtimePlan: {},
        sessionId: "session",
      },
      setup: createAttemptSetupFixture(),
      isRawModelRun: false,
      preparedToolBase: {
        cronCreatorToolAllowlist: [],
        cronCreatorToolAllowlistCaptureRef: {},
        inheritedToolAllowlist,
        additionalInheritedToolNamesRef: [],
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: resolveConversationCapabilityProfile({}),
        toolsEnabled: true,
        toolsRaw,
      },
    } as unknown as Parameters<typeof prepare>[0];
  }

  function mockMcp(tools: Array<{ name: string }> = [], dispose?: () => Promise<void>) {
    mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({ tools, dispose });
  }

  function clientTools(...names: string[]) {
    return names.map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" as const } },
    }));
  }

  function setAllow(input: ReturnType<typeof createInput>, allow: string[]) {
    input.attempt.toolsAllow = allow;
    input.preparedToolBase.effectiveToolsAllow = allow;
  }

  const toolNames = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

  function pluginTool(name: string, pluginId: string) {
    const tool = createStubTool(name);
    setPluginToolMeta(tool, { pluginId, optional: false });
    return tool;
  }

  it.each(["memory flush", "disabled tools", "raw", "restart", "model"])(
    "does not widen %s with auxiliary tools",
    async (mode) => {
      const input = createInput([], [createStubTool("read"), createStubTool("write")]);
      input.attempt.config = { mcp: { servers: { chrome: { command: "unused" } } } };
      input.attempt.toolsAllow = ["raw", "restart", "model"].includes(mode)
        ? ["chrome*"]
        : undefined;
      input.attempt.disableTools = mode === "disabled tools";
      input.isRawModelRun = mode === "raw";
      input.attempt.forceRestartSafeTools = mode === "restart";
      input.preparedToolBase.toolsEnabled = mode !== "model";
      if (mode === "memory flush") {
        input.attempt.trigger = "memory";
        input.attempt.memoryFlushWritePath = "memory/2026-10-08.md";
      }
      input.attempt.clientTools = clientTools("client_canary");
      mockMcp([createStubTool("canary__write")]);
      mocks.createBundleLspToolRuntime.mockResolvedValue({
        tools: [createStubTool("lsp_canary")],
        dispose: vi.fn(),
      });

      const result = await prepare(input);

      const expected = mode === "model" ? [] : ["read", "write"];
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(expected);
      expect(result.clientTools).toBeUndefined();
      expect(mocks.acquireSessionMcpRuntime).not.toHaveBeenCalled();
      expect(mocks.createBundleLspToolRuntime).not.toHaveBeenCalled();
      expect(mocks.materializeBundleMcpToolsForRun).not.toHaveBeenCalled();
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(expected);
    },
  );

  it.each([
    { allow: ["group:plugins"], expected: ["lsp_hover_typescript", "lsp_definition_typescript"] },
    { allow: ["*hover*"], expected: ["lsp_hover_typescript"] },
  ])("discovers LSP for $allow without widening final tools", async (testCase) => {
    const input = createInput();
    setAllow(input, testCase.allow);
    const lspTools = ["lsp_hover_typescript", "lsp_definition_typescript"].map((name) =>
      pluginTool(name, "bundle-lsp"),
    );
    mocks.createBundleLspToolRuntime.mockResolvedValue({ tools: lspTools, dispose: vi.fn() });

    const result = await prepare(input);

    expect(mocks.createBundleLspToolRuntime).toHaveBeenCalledOnce();
    expect(toolNames(result.uncompactedEffectiveTools)).toEqual(testCase.expected);
  });

  it.each<[string[], string, boolean | undefined, boolean | undefined, number]>([
    [["chrome"], "chrome*", false, undefined, 0],
    [["chrome"], "chrome*", false, true, 1],
    [["9chrome"], "mcp-9chrome*", undefined, undefined, 1],
    [["a".repeat(31), "a".repeat(32)], `${"a".repeat(28)}-2*`, undefined, undefined, 1],
  ])("resolves configured MCP %j for %s", async (servers, allow, enabled, override, calls) => {
    const input = createInput();
    input.attempt.config = {
      plugins: { enabled: false },
      mcp: {
        servers: Object.fromEntries(servers.map((name) => [name, { command: "unused", enabled }])),
      },
    };
    input.attempt.toolsAllow = [allow];
    if (override !== undefined) {
      input.attempt.toolOverrides = { mcpServers: { chrome: override } };
    }
    await prepare(input);
    expect(mocks.acquireSessionMcpRuntime).toHaveBeenCalledTimes(calls);
  });

  it("allocates configured namespaces after colliding enabled plugin servers", async () => {
    const input = createInput();
    input.attempt.config = {
      plugins: { entries: { "native-mcp": { enabled: true } } },
      mcp: { servers: { "chrome-dev": { command: "unused" } } },
    };
    setAllow(input, ["chrome-dev-2*"]);
    const registry = makeRegistry([{ id: "native-mcp", channels: [] }]);
    const record = registry.plugins[0];
    if (!record) {
      throw new Error("missing native plugin fixture");
    }
    record.format = "openclaw";
    record.mcpServers = { "chrome dev": { command: "unused" } };
    const snapshot = createPluginMetadataSnapshot({
      config: input.attempt.config,
      manifestRegistry: registry,
    });
    input.setup.getCurrentAttemptPluginMetadataSnapshot = () => snapshot;
    mockMcp([{ name: "chrome-dev__click" }, { name: "chrome-dev-2__click" }]);

    const result = await prepare(input);

    expect(toolNames(result.uncompactedEffectiveTools)).toEqual(["chrome-dev-2__click"]);
  });

  const wildcardClients = ["client_read", "client_delete"];
  it.each<[string, string[], string[], string[]]>([
    ["explicitly empty capabilities", [], ["client_read"], []],
    ["wildcard capabilities", ["*"], wildcardClients, wildcardClients],
    ["canonical tool groups", ["group:fs"], ["read", "write", "exec"], ["read", "write"]],
    [
      "independent glob intersections",
      attachToolAllowlistIntersection(
        ["client_read", "client_write", "other_read"],
        [["client_*"], ["*_read"]],
      ),
      ["client_read", "client_write", "other_read"],
      ["client_read"],
    ],
  ])(
    "applies the effective client-function capability to %s",
    async (_name, allow, clients, expected) => {
      const input = createInput();
      input.attempt.clientTools = clientTools(...clients);
      setAllow(input, allow);

      const result = await prepare(input);

      expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(expected);
    },
  );

  it("removes unauthorized client names before MCP and LSP tool reservation", async () => {
    const input = createInput([], [{ name: "message" }]);
    setAllow(input, ["client_allowed", "bundle-mcp", "lsp_probe"]);
    input.attempt.clientTools = clientTools("client_allowed", "client_forbidden");
    mockMcp();

    const result = await prepare(input);

    expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(["client_allowed"]);
    expect(mocks.materializeBundleMcpToolsForRun).toHaveBeenCalledWith(
      expect.objectContaining({ reservedToolNames: ["message", "client_allowed"] }),
    );
    expect(mocks.createBundleLspToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ reservedToolNames: ["message", "client_allowed"] }),
    );
  });

  it.each([
    { runtime: undefined, publicationAllowed: true },
    { runtime: ["sessions_spawn", "server__read"], publicationAllowed: false },
  ])(
    "retains unavailable publication under the final runtime cap: $publicationAllowed",
    async ({ runtime, publicationAllowed }) => {
      const inherited = ["sessions_spawn", "github_publish"];
      const input = createInput(inherited, [createStubTool("sessions_spawn")]);
      input.preparedToolBase.additionalInheritedToolNamesRef = ["github_publish"];
      input.preparedToolBase.effectiveToolsAllow = runtime;
      mockMcp([createStubTool("server__read"), createStubTool("server__delete")]);
      mocks.applyFinalEffectiveToolPolicy.mockImplementation(
        ({ bundledTools }: { bundledTools: Array<{ name: string }> }) =>
          bundledTools.filter((tool) => tool.name !== "server__delete"),
      );
      const result = await prepare(input);
      expect(inherited).toEqual(
        publicationAllowed
          ? ["sessions_spawn", "server__read", "github_publish"]
          : ["sessions_spawn", "server__read"],
      );
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual([
        "sessions_spawn",
        "server__read",
      ]);
      expect(
        input.preparedToolBase.cronCreatorToolAllowlist.map((entry) =>
          typeof entry === "string" ? entry : entry.name,
        ),
      ).not.toContain("github_publish");

      input.preparedToolBase.additionalInheritedToolNamesRef.length = 0;
      result.refreshTools(() => {});
      expect(inherited).not.toContain("github_publish");
    },
  );

  it("refreshes retained tools and capability captures from each schema projection", async () => {
    await withStateDirEnv("openclaw-bundle-tool-quarantine-", async () => {
      const { filterRuntimeCompatibleTools } = await vi.importActual<
        typeof import("../../tool-schema-projection.js")
      >("../../tool-schema-projection.js");
      mocks.filterRuntimeCompatibleTools.mockImplementation(filterRuntimeCompatibleTools);
      const first = createStubTool("core_first");
      const bundled = pluginTool("server__read", "bundle-mcp");
      const bundledSchema = { type: "object" };
      bundled.parameters = bundledSchema;
      const core = [first];
      const inherited = ["initial"];
      const input = createInput(inherited, core);
      const creatorTools = input.preparedToolBase.cronCreatorToolAllowlist;
      const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};
      input.preparedToolBase.cronCreatorToolAllowlistCaptureRef = captureRef;
      mockMcp([bundled]);

      const result = await prepare(input);
      const retained = result.uncompactedEffectiveTools;
      expect(toolNames(retained)).toEqual(["core_first", "server__read"]);
      expect(core).toEqual([first]);
      expect(creatorTools).toEqual([
        { name: "core_first" },
        { name: "server__read", pluginId: "bundle-mcp" },
      ]);
      expect(captureRef.value).toEqual({ version: 1, source: "final-executable-surface" });

      const second = createStubTool("core_second");
      core.splice(0, core.length, second);
      bundledSchema.type = "array";
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));

      expect(toolNames(retained)).toEqual(["core_second"]);
      expect(core).toEqual([second]);
      expect(inherited).toEqual(["core_second"]);
      expect(creatorTools).toEqual([{ name: "core_second" }]);
      expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([
        {
          toolName: "server__read",
          owner: "plugin:bundle-mcp",
          reason: 'server__read.parameters.type must be "object"',
          failedAt: expect.any(Date),
        },
      ]);

      core.splice(0, core.length, first);
      bundledSchema.type = "object";
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));

      expect(toolNames(retained)).toEqual(["core_first", "server__read"]);
      expect(core).toEqual([first]);
      expect(inherited).toEqual(["core_first", "server__read"]);
      expect(creatorTools).toEqual([
        { name: "core_first" },
        { name: "server__read", pluginId: "bundle-mcp" },
      ]);
      expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([]);
    });
  });

  it("disposes prepared runtimes after policy failure and retains MCP cleanup failure", async () => {
    const disposeMcp = vi.fn(async () => {
      throw new Error("MCP disposal failed");
    });
    const disposeLsp = vi.fn(async () => {});
    mockMcp([], disposeMcp);
    mocks.createBundleLspToolRuntime.mockResolvedValue({ tools: [], dispose: disposeLsp });
    mocks.applyFinalEffectiveToolPolicy.mockImplementation(() => {
      throw new Error("bundle policy failed");
    });

    const cleanupScope = createAgentCleanupScope();
    await expect(cleanupScope.run(() => prepare(createInput()))).rejects.toThrow(
      "bundle policy failed",
    );
    expect(cleanupScope.outcome).toBe("uncertain");
    expect(mocks.applyFinalEffectiveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
    );
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });
});
