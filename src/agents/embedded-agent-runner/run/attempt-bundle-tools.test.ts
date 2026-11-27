import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../../config/plugin-auto-enable.test-helpers.js";
import { withDiagnosticsTimelineObserver } from "../../../infra/diagnostics-timeline.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import { readAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { gateAgentToolExecution } from "../../agent-tool-availability.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { prepareParticipationTestRun } from "../../participation-ceiling.test-support.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import { createClientToolDefinition, createStubTool } from "../../test-helpers/agent-tool-stubs.js";
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
        admittedRunContext: createTestAdmittedRunContext("run"),
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
        messageToolAvailable: true,
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

  it.each([
    { tools: undefined, allowed: false },
    { tools: [], allowed: false },
    { tools: ["fixture__*"], allowed: true },
    { tools: ["group:plugins"], allowed: true },
    { tools: ["*"], allowed: true },
  ])(
    "starts MCP only when participant policy $tools can admit its tools",
    async ({ tools, allowed }) => {
      const input = createInput();
      input.attempt.config = { mcp: { servers: { fixture: { command: "unused" } } } };
      input.attempt.admittedRunContext = await prepareParticipationTestRun({
        kind: "send",
        profileId: "participant",
        sessionKey: "agent:main:participant",
        tools,
      }).preparedRunAdmission.admit("embedded");
      input.preparedToolBase.runtimeCapabilityProfile = resolveConversationCapabilityProfile({
        config: input.attempt.config,
        pluginExecutionAuthority: readAdmittedRunOperatorAuthority(
          input.attempt.admittedRunContext,
        ),
      });
      const actual = await vi.importActual<typeof import("../effective-tool-policy.js")>(
        "../effective-tool-policy.js",
      );
      mocks.applyFinalEffectiveToolPolicy.mockImplementation(actual.applyFinalEffectiveToolPolicy);
      mockMcp([pluginTool("fixture__read", "bundle-mcp")]);
      const result = await prepare(input);
      expect(mocks.acquireSessionMcpRuntime).toHaveBeenCalledTimes(Number(allowed));
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(allowed ? ["fixture__read"] : []);
    },
  );

  it.each(["memory flush", "disabled tools", "raw", "model", "global denial"])(
    "does not widen %s with auxiliary tools",
    async (mode) => {
      const input = createInput([], [createStubTool("read"), createStubTool("write")]);
      input.attempt.config = { mcp: { servers: { chrome: { command: "unused" } } } };
      input.attempt.toolsAllow = ["raw", "model"].includes(mode) ? ["chrome*"] : undefined;
      input.attempt.disableTools = mode === "disabled tools";
      input.isRawModelRun = mode === "raw";
      input.preparedToolBase.toolsEnabled = mode !== "model";
      if (mode === "global denial") {
        input.attempt.config.tools = { deny: ["*"] };
        input.preparedToolBase.runtimeCapabilityProfile = resolveConversationCapabilityProfile({
          config: input.attempt.config,
        });
        input.preparedToolBase.toolsRaw = [];
      }
      if (mode === "memory flush") {
        input.attempt.trigger = "memory";
        input.attempt.memoryFlushWritePath = "memory/2026-10-08.md";
      }
      input.attempt.clientTools = [createClientToolDefinition("client_canary")];
      mockMcp([createStubTool("canary__write")]);
      mocks.createBundleLspToolRuntime.mockResolvedValue({
        tools: [createStubTool("lsp_canary")],
        dispose: vi.fn(),
      });

      const result = await prepare(input);

      expect(mocks.acquireSessionMcpRuntime).not.toHaveBeenCalled();
      expect(mocks.createBundleLspToolRuntime).not.toHaveBeenCalled();
      const expected = ["model", "global denial"].includes(mode) ? [] : ["read", "write"];
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(expected);
      expect(result.clientTools).toBeUndefined();
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(expected);
    },
  );

  it.each([
    ["chrome dev", "chrome-dev", "chrome-dev", "chrome-dev-2"],
    ["a".repeat(31), "a".repeat(32), "a".repeat(30), `${"a".repeat(28)}-2`],
  ])(
    "allocates configured %s namespaces after colliding plugin servers",
    async (pluginName, configuredName, first, second) => {
      const input = createInput();
      input.attempt.config = {
        plugins: { entries: { "native-mcp": { enabled: true } } },
        mcp: { servers: { [configuredName]: { command: "unused" } } },
      };
      setAllow(input, [`${second}*`]);
      const registry = makeRegistry([{ id: "native-mcp", channels: [] }]);
      const record = registry.plugins[0];
      if (!record) {
        throw new Error("missing native plugin fixture");
      }
      record.format = "openclaw";
      record.mcpServers = { [pluginName]: { command: "unused" } };
      const snapshot = createPluginMetadataSnapshot({
        config: input.attempt.config,
        manifestRegistry: registry,
      });
      input.setup.getCurrentAttemptPluginMetadataSnapshot = () => snapshot;
      mockMcp([{ name: `${first}__click` }, { name: `${second}__click` }]);

      const result = await prepare(input);

      expect(toolNames(result.uncompactedEffectiveTools)).toEqual([`${second}__click`]);
    },
  );

  const clients = ["client_read", "client_write", "other_read"];
  it.each<[string, string[], string[], boolean]>([
    ["empty", [], [], false],
    [
      "intersected",
      attachToolAllowlistIntersection(clients, [["client_*"], ["*_read"]]),
      ["client_read"],
      false,
    ],
    ["reserved", ["client_read", "bundle-mcp", "lsp_probe"], ["client_read"], true],
  ])(
    "applies %s client capabilities before tool reservation",
    async (_name, allow, expected, reserves) => {
      const input = createInput([], [{ name: "message" }]);
      input.attempt.clientTools = clients.map(createClientToolDefinition);
      setAllow(input, allow);
      mockMcp();
      mocks.createBundleLspToolRuntime.mockResolvedValue({
        tools: ["lsp_probe", "lsp_forbidden"].map((name) => pluginTool(name, "bundle-lsp")),
        dispose: vi.fn(),
      });
      const result = await prepare(input);
      expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(expected);
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(
        reserves ? ["message", "lsp_probe"] : ["message"],
      );
      if (reserves) {
        const reservation = expect.objectContaining({
          reservedToolNames: ["message", ...expected],
        });
        expect(mocks.materializeBundleMcpToolsForRun).toHaveBeenCalledWith(reservation);
        expect(mocks.createBundleLspToolRuntime).toHaveBeenCalledWith(reservation);
      }
    },
  );

  it.each(["available", "policy-removed", "quarantined"] as const)(
    "keeps presentation omission separate from final permission capture: %s",
    async (mode) =>
      await withStateDirEnv("message-presentation-capture-", async () => {
        const inherited = ["message"];
        const message = createStubTool("message");
        const input = createInput(inherited, mode === "policy-removed" ? [] : [message]);
        input.preparedToolBase = { ...input.preparedToolBase, messageToolAvailable: false };
        input.preparedToolBase.cronCreatorToolAllowlist.push({ name: "message" });
        if (mode === "quarantined") {
          const { filterRuntimeCompatibleTools } = await vi.importActual<
            typeof import("../../tool-schema-projection.js")
          >("../../tool-schema-projection.js");
          mocks.filterRuntimeCompatibleTools.mockImplementation(filterRuntimeCompatibleTools);
          message.parameters = { type: "array" };
        }
        const result = await prepare(input);
        expect(toolNames(result.uncompactedEffectiveTools)).not.toContain("message");
        expect(inherited.includes("message")).toBe(mode === "available");
        expect(
          input.preparedToolBase.cronCreatorToolAllowlist.some(
            (entry) => (typeof entry === "string" ? entry : entry.name) === "message",
          ),
        ).toBe(mode === "available");
        result.refreshTools(() => {});
        expect(toolNames(result.uncompactedEffectiveTools)).not.toContain("message");
        expect(inherited.includes("message")).toBe(mode === "available");
      }),
  );

  it("never delegates or captures a listed tool this turn refuses", async () =>
    await withStateDirEnv("refused-tool-capture-", async () => {
      const inherited = ["read", "exec"];
      const exec = gateAgentToolExecution(createStubTool("exec"), "exec is refused");
      const input = createInput(inherited, [createStubTool("read"), exec]);
      input.preparedToolBase.cronCreatorToolAllowlist.push({ name: "read" }, { name: "exec" });
      const result = await prepare(input);
      expect(toolNames(result.uncompactedEffectiveTools)).toEqual(["read", "exec"]);
      expect(inherited).toEqual(["read"]);
      expect(
        input.preparedToolBase.cronCreatorToolAllowlist.map((entry) =>
          typeof entry === "string" ? entry : entry.name,
        ),
      ).toEqual(["read"]);
    }));

  it("keeps an unavailable message tool listed when the session lists one fixed set", async () => {
    // A cron turn without a delivery route must not freeze a series without `message`.
    const input = createInput([], [createStubTool("message")]);
    input.preparedToolBase = {
      ...input.preparedToolBase,
      messageToolAvailable: false,
      fixedListing: true,
    } as typeof input.preparedToolBase;
    const result = await prepare(input);
    expect(toolNames(result.uncompactedEffectiveTools)).toContain("message");
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
      mockMcp([bundled]);

      const result = await prepare(input);
      const retained = result.uncompactedEffectiveTools;
      expect(input.preparedToolBase.cronCreatorToolAllowlistCaptureRef.value).toEqual({
        version: 1,
        source: "final-executable-surface",
      });
      expect(toolNames(retained)).toEqual(["core_first", "server__read"]);
      expect(creatorTools).toEqual([
        { name: "core_first" },
        { name: "server__read", pluginId: "bundle-mcp" },
      ]);

      const second = createStubTool("core_second");
      core.splice(0, core.length, second);
      bundledSchema.type = "array";
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));

      expect(toolNames(retained)).toEqual(["core_second"]);
      expect(inherited).toEqual(["core_second"]);
      expect(creatorTools).toEqual([{ name: "core_second" }]);
      expect(await listPersistedRuntimeToolSchemaQuarantines()).toMatchObject([
        {
          toolName: "server__read",
          owner: "plugin:bundle-mcp",
        },
      ]);

      core.splice(0, core.length, first);
      bundledSchema.type = "object";
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));

      expect(toolNames(retained)).toEqual(["core_first", "server__read"]);
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
    const completed: string[] = [];
    await expect(
      withDiagnosticsTimelineObserver(
        (name) => () => {
          completed.push(name);
        },
        () => cleanupScope.run(() => prepare(createInput())),
      ),
    ).rejects.toThrow("bundle policy failed");
    expect(completed).toContain("attempt.bundle-tools.policy");
    expect(completed).toContain("attempt.bundle-tools.cleanup");
    expect(cleanupScope.outcome).toBe("uncertain");
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });
});
