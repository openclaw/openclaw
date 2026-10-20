import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  getEmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../../../infra/embedded-plugin-approval-broker.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { createCodeModeCatalogProjection } from "../../code-mode-catalog.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "../../code-mode.js";
import { runUntilCompleted } from "../../code-mode.test-support.js";
import { createAgentHarnessPromptToolPolicy } from "../../harness/prompt-tool-policy.js";
import { getInternalToolExecutionPreparer } from "../../runtime/internal-hooks.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { compactToolSearchCatalogEntry } from "../../tool-search-catalog.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../../tool-search.js";
import { jsonResult } from "../../tools/common.js";
import { createInstalledSkillTools } from "../../tools/installed-skill-tools.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";

const CODE_MODE_CONFIG: OpenClawConfig = { tools: { codeMode: true, toolSearch: false } };
const TOOL_SEARCH_CONFIG: OpenClawConfig = {
  tools: { codeMode: false, toolSearch: { enabled: true, mode: "tools" } },
};
const CATALOGS_DISABLED_CONFIG: OpenClawConfig = {
  tools: { codeMode: false, toolSearch: false },
};
const RUN_CONTEXT = {
  sessionId: "session",
  sessionKey: "session-key",
  agentId: "main",
  runId: "run",
};

function clientTool(name: string) {
  return {
    type: "function" as const,
    function: { name, description: `client ${name}`, parameters: { type: "object" } },
  };
}

function pluginTool(
  name: string,
  pluginId: string,
  metadata: Partial<Parameters<typeof setPluginToolMeta>[1]> = {},
) {
  const tool = createStubTool(name);
  setPluginToolMeta(tool, { pluginId, optional: false, ...metadata });
  return tool;
}

// Register a real catalog: otherwise client append is a no-op in both branches.
function seedCatalog(mode: "code-mode" | "tool-search", config: OpenClawConfig) {
  const catalogRef = createToolSearchCatalogRef();
  const context = { config, catalogRef, ...RUN_CONTEXT };
  const controlTools =
    mode === "code-mode"
      ? createCodeModeTools({
          ...context,
          executeTool: async () => ({ content: [], details: {} }),
        })
      : [createStubTool(TOOL_SEARCH_RAW_TOOL_NAME)];
  const applyCatalog = mode === "code-mode" ? applyCodeModeCatalog : applyToolSearchCatalog;
  expect(
    applyCatalog({ ...context, tools: [...controlTools, createStubTool("seeded_target")] })
      .catalogRegistered,
  ).toBe(true);
  return catalogRef;
}

type PrepareParams = Parameters<typeof prepareEmbeddedAttemptClientTools>[0];
function prepare({
  attemptConfig = CATALOGS_DISABLED_CONFIG,
  catalogRef = createToolSearchCatalogRef(),
  ...overrides
}: Partial<Omit<PrepareParams, "attempt">> & {
  attemptConfig?: OpenClawConfig;
  catalogRef?: ReturnType<typeof createToolSearchCatalogRef>;
} = {}) {
  return prepareEmbeddedAttemptClientTools({
    attempt: { config: attemptConfig, sessionId: "session", runId: "run" },
    catalogToolHookContext: undefined,
    codeModeControlsEnabledForRun: false,
    deferredDirectoryToolsCallable: false,
    effectiveTools: [],
    replaySafetyOptions: { declaredReplaySafe: () => undefined },
    sandboxSessionKey: "session-key",
    sessionAgentId: "main",
    toolSearchCatalogRef: catalogRef,
    toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
    uncompactedEffectiveTools: [],
    clientTools: [clientTool("client_probe")],
    ...overrides,
  } as unknown as PrepareParams);
}

function installHooks(hooks: Parameters<typeof createMockPluginRegistry>[0]) {
  const previousRegistry = getGlobalPluginRegistry();
  initializeGlobalHookRunner(createMockPluginRegistry(hooks));
  return () => {
    resetGlobalHookRunner();
    if (previousRegistry) {
      initializeGlobalHookRunner(previousRegistry);
    }
  };
}

function clientTurn(tool: ReturnType<typeof wrapToolDefinition>, value: number) {
  const toolCall = {
    type: "toolCall" as const,
    id: "lookup_0",
    name: tool.name,
    arguments: { value },
  };
  const context = {
    assistantMessage: makeAgentAssistantMessage({
      content: [toolCall],
      turnId: `turn-${value}`,
      stopReason: "toolUse",
    }),
    toolCall,
  };
  return () =>
    runWithAgentToolExecutionContext(context, () => tool.execute(toolCall.id, toolCall.arguments));
}

describe("prepareEmbeddedAttemptClientTools", () => {
  it("keeps reused client call ids distinct across assistant turns and stable on replay", async () => {
    const prepared = prepare();
    const tool = wrapToolDefinition(expectDefined(prepared.clientToolDefs[0], "client tool"));
    for (const value of [1, 2]) {
      const execute = clientTurn(tool, value);
      await execute();
      await execute();
      expect(prepared.clientToolCallSlots).toHaveLength(value);
    }
    expect(prepared.clientToolCallSlots).toEqual([
      { toolCallId: "lookup_0", name: "client_probe", completed: true, params: { value: 1 } },
      { toolCallId: "lookup_0", name: "client_probe", completed: true, params: { value: 2 } },
    ]);
  });

  it("preserves a completed client call when a later turn reuses its id and is blocked", async () => {
    const restoreHooks = installHooks([
      {
        hookName: "before_tool_call",
        matcher: ["client_probe"],
        handler: vi
          .fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValue({ block: true, blockReason: "blocked second call" }),
      },
    ]);
    try {
      const prepared = prepare();
      const tool = wrapToolDefinition(expectDefined(prepared.clientToolDefs[0], "client tool"));
      for (const value of [1, 2]) {
        const result = await clientTurn(tool, value)();
        expect(result.details).toMatchObject({ status: value === 1 ? "pending" : "blocked" });
      }
      expect(prepared.clientToolCallSlots.filter((slot) => slot.completed)).toEqual([
        { toolCallId: "lookup_0", name: "client_probe", completed: true, params: { value: 1 } },
      ]);
    } finally {
      restoreHooks();
    }
  });

  it("keeps authoritative client slots in source order across delayed hooks", async () => {
    const firstHook = createDeferredCore();
    const pending: Promise<unknown>[] = [];
    const restoreHooks = installHooks([
      {
        hookName: "before_tool_call",
        matcher: ["first_tool"],
        handler: () => firstHook.promise,
      },
    ]);
    try {
      const prepared = prepare({
        clientTools: [clientTool("first_tool"), clientTool("second_tool")],
      });
      const tools = prepared.clientToolDefs.map((definition) => wrapToolDefinition(definition));
      const firstTool = expectDefined(tools[0], "first client tool");
      const secondTool = expectDefined(tools[1], "second client tool");
      const first = firstTool.execute("first-call", { value: 1 });
      pending.push(Promise.allSettled([first]));
      const second = secondTool.execute("second-call", { value: 2 });
      pending.push(Promise.allSettled([second]));
      await withTestTimeout(second, 2_000, "second client tool did not finish");
      expect(prepared.clientToolCallSlots).toEqual([
        { toolCallId: "first-call", name: "first_tool", completed: false },
        { toolCallId: "second-call", name: "second_tool", completed: true, params: { value: 2 } },
      ]);
      firstHook.resolve();
      await withTestTimeout(first, 2_000, "first client tool did not finish");
      expect(prepared.clientToolCallSlots).toEqual([
        { toolCallId: "first-call", name: "first_tool", completed: true, params: { value: 1 } },
        { toolCallId: "second-call", name: "second_tool", completed: true, params: { value: 2 } },
      ]);
    } finally {
      firstHook.resolve();
      try {
        await withTestTimeout(Promise.all(pending), 2_000, "client cleanup did not settle");
      } finally {
        restoreHooks();
      }
    }
  }, 10_000);

  it.each(["execute", "prepare"] as const)(
    "removes an adapted MCP tool's pending approval when its permission generation ends during %s",
    async (executionPath) => {
      const previousMode = isEmbeddedMode();
      const previousBroker = getEmbeddedPluginApprovalBroker();
      const requested = createDeferredCore();
      const broker = new EmbeddedPluginApprovalBroker((event) => {
        if (event.event === "plugin.approval.requested") {
          requested.resolve();
        }
      });
      setEmbeddedMode(true);
      setEmbeddedPluginApprovalBroker(broker);
      const restoreHooks = installHooks([
        {
          hookName: "before_tool_call",
          handler: () => ({
            requireApproval: { title: "MCP write", description: "Approve remote mutation" },
          }),
        },
      ]);
      const generation = new AbortController();
      const execute = vi.fn(async () => jsonResult({ changed: true }));
      const mcpTool = wrapToolWithAbortSignal(
        { ...createStubTool("mcp_write"), execute },
        generation.signal,
      );
      const prepared = prepare({
        effectiveTools: [mcpTool],
        uncompactedEffectiveTools: [mcpTool],
        clientTools: [],
        getToolAbortSignal: () => generation.signal,
      });
      const tool = wrapToolDefinition(prepared.allCustomTools[0]!);
      const execution =
        executionPath === "execute"
          ? tool.execute(`generation-${executionPath}`, {})
          : getInternalToolExecutionPreparer(tool)!({
              toolCallId: `generation-${executionPath}`,
              args: {},
            });
      const settled = Promise.allSettled([execution]);
      try {
        await requested.promise;
        expect(broker.listPending()).toHaveLength(1);
        generation.abort(new Error("Permission change"));
        expect(broker.listPending()).toHaveLength(0);
        await settled;
        expect(execute).not.toHaveBeenCalled();
      } finally {
        broker.stop();
        await settled;
        setEmbeddedPluginApprovalBroker(previousBroker);
        setEmbeddedMode(previousMode);
        restoreHooks();
      }
    },
  );

  it("stores capable tool names policy-normalized, as completion compares them", () => {
    const capable = Object.assign(createStubTool("Order_Status"), {
      canDeliverSourceReply: true,
    });
    const plain = createStubTool("order_lookup");

    const result = prepare({
      effectiveTools: [capable, plain],
      uncompactedEffectiveTools: [capable, plain],
    });

    expect(result.sourceReplyCapableToolNames).toEqual(new Set(["order_status"]));
  });

  it("collects exact local-media trust from core policy and plugin metadata", () => {
    const trustedPluginTool = pluginTool("plugin_media", "trusted-plugin", {
      trustedLocalMedia: true,
    });
    const untrustedPluginTool = pluginTool("browser", "untrusted-plugin");
    const uncompactedEffectiveTools = [
      createStubTool("read"),
      createStubTool("sessions_yield"),
      trustedPluginTool,
      untrustedPluginTool,
    ];

    const result = prepare({ uncompactedEffectiveTools });

    const trustedLocalMediaToolNames = result.trustedLocalMediaToolNames;
    expect(trustedLocalMediaToolNames).toEqual(new Set(["read", "plugin_media"]));

    uncompactedEffectiveTools.splice(0, uncompactedEffectiveTools.length, untrustedPluginTool);
    result.refreshTools();

    expect(result.trustedLocalMediaToolNames).toBe(trustedLocalMediaToolNames);
    expect(result.trustedLocalMediaToolNames).toEqual(new Set());
  });

  it("rebuilds pinned tools from the refreshed catalog", async () => {
    const executorOf = (name: string, generation: string) =>
      Object.assign(createStubTool(name), {
        execute: async () => jsonResult({ generation }),
      });
    const effectiveTools = [executorOf("read", "before"), executorOf("gateway", "before")];
    const pinned = new Set<string>();
    const result = prepare({
      effectiveTools,
      clientTools: [],
      pinTools: (tools) => {
        for (const tool of tools) {
          pinned.add(tool.name);
        }
        return [
          ...tools,
          ...[...pinned]
            .filter((name) => !tools.some((tool) => tool.name === name))
            .map((name) => executorOf(name, "gated")),
        ];
      },
    });

    effectiveTools.splice(0, effectiveTools.length, executorOf("read", "after"));
    result.refreshTools();

    const run = async (name: string) => {
      const tool = wrapToolDefinition(
        expectDefined(
          result.allCustomTools.find((entry) => entry.name === name),
          name,
        ),
      );
      return (await tool.execute("call", {})).details;
    };
    expect(await run("read")).toEqual({ generation: "after" });
    expect(await run("gateway")).toEqual({ generation: "gated" });
  });

  it.each(["code-mode", "tool-search"] as const)("hides client tools behind %s catalog", (mode) => {
    const codeMode = mode === "code-mode";
    const config = codeMode ? CODE_MODE_CONFIG : TOOL_SEARCH_CONFIG;
    const catalogRef = seedCatalog(mode, config);
    // Disable the other config source to prove each mode reads its owner.
    const result = prepare({
      codeModeControlsEnabledForRun: codeMode,
      attemptConfig: codeMode ? config : CATALOGS_DISABLED_CONFIG,
      toolSearchRuntimeConfig: codeMode ? CATALOGS_DISABLED_CONFIG : config,
      catalogRef,
    });
    expect(result.clientToolDefs).toEqual([]);
    expect(result.allCustomTools).toEqual([]);
  });

  it("advertises and invokes final callable owners after a normalized client collision", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const codeModeSkills = [
      {
        name: "fixture-skill",
        description: "Keep existing Code Mode skill guidance.",
        location: "/fixture/SKILL.md",
        source: { filePath: "/fixture/SKILL.md", readContent: "fixture" },
      },
    ];
    const skillTools = createInstalledSkillTools(codeModeSkills);
    const receivedSecrets: unknown[] = [];
    const trustedPlugin = Object.assign(createStubTool("llm-task"), {
      description: "harvesting trusted helper",
      parameters: Type.Object({ secret: Type.String() }),
      outputSchema: Type.Object({ receipt: Type.String() }, { additionalProperties: false }),
      execute: async (_toolCallId: string, input: unknown) => {
        receivedSecrets.push(input);
        return jsonResult({ receipt: "trusted-plugin" });
      },
    });
    setPluginToolMeta(trustedPlugin, { pluginId: "trusted-plugin", optional: false });
    const shadowedPlugin = Object.assign(createStubTool("hidden_owner"), {
      description: "orchard harvesting orchard harvesting",
    });
    setPluginToolMeta(shadowedPlugin, { pluginId: "trusted-plugin", optional: false });
    const context = {
      config: CODE_MODE_CONFIG,
      ...RUN_CONTEXT,
      catalogRef,
      codeModeSkills,
    };
    const controls = createCodeModeTools(context);
    const compacted = applyCodeModeCatalog({
      tools: [...controls, ...skillTools, trustedPlugin, shadowedPlugin],
      ...context,
    });
    const initialPrompt = buildCodeModeCatalogPrompt(context, catalogRef.current?.entries ?? []);
    const initialDescription = compacted.tools.find((tool) => tool.name === "exec")?.description;
    expect(initialPrompt).toContain("- llm_task { secret: string } -> { receipt: string }");
    expect(initialPrompt).toContain("skills.read(name)");

    const prepared = prepare({
      codeModeControlsEnabledForRun: true,
      attemptConfig: CODE_MODE_CONFIG,
      catalogRef,
      effectiveTools: compacted.tools.map((tool) =>
        wrapEmbeddedAttemptToolWithActivity(tool, "run"),
      ),
      uncompactedEffectiveTools: [...skillTools, trustedPlugin, shadowedPlugin],
      clientTools: [clientTool("llm_task"), clientTool("hidden_owner")],
    });
    const projection = createCodeModeCatalogProjection(
      (catalogRef.current?.entries ?? []).map(compactToolSearchCatalogEntry),
    );
    const trustedBinding = projection.bindings.find((binding) => binding.name === "llm-task");
    expect(trustedBinding?.callableName).toMatch(/^llm_task_[a-f0-9]{8}$/);
    expect(projection.byCallableName.get("llm_task")?.source).toBe("client");

    const providerExec = prepared.allCustomTools.find((tool) => tool.name === "exec");
    expect(providerExec?.description).toBe(initialDescription);
    const providerPrompt = buildCodeModeCatalogPrompt(context, catalogRef.current?.entries ?? []);
    expect(providerPrompt).toContain("- llm_task unknown -> ?");
    expect(providerPrompt).toContain(
      `- ${trustedBinding?.callableName} { secret: string } -> { receipt: string }`,
    );
    expect(providerPrompt).toContain("skills.read(name)");

    const guestResult = await runUntilCompleted({
      execTool: controls[0]!,
      waitTool: controls[1]!,
      code: `
        const [match] = await catalog.search("orchard harvesting", { limit: 1 });
        const result = await match({ secret: "fixture-secret-never-client" });
        return { callableName: match.callableName, result };
      `,
    });
    expect(guestResult.value).toEqual({
      callableName: trustedBinding?.callableName,
      result: { receipt: "trusted-plugin" },
    });
    expect(receivedSecrets).toEqual([{ secret: "fixture-secret-never-client" }]);
    expect(prepared.clientToolCallSlots).toEqual([]);

    createAgentHarnessPromptToolPolicy({
      tools: prepared.allCustomTools,
      catalogRef,
      codeModeControlsEnabled: true,
    }).apply({ toolsAllow: ["llm-task"] });
    const restrictedPrompt = buildCodeModeCatalogPrompt(context, catalogRef.current?.entries ?? []);
    expect(restrictedPrompt).toContain("- llm_task { secret: string } -> { receipt: string }");
    expect(restrictedPrompt).not.toContain("- llm_task unknown -> ?");
    expect(restrictedPrompt).not.toContain(trustedBinding?.callableName);
    expect(restrictedPrompt).not.toContain("skills.read(");
    expect(restrictedPrompt).not.toContain("skills.search(");
    expect(providerExec?.description).toBe(initialDescription);
  });

  it("keeps client tools directly callable for directory Tool Search", () => {
    const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);

    const result = prepare({
      attemptConfig: TOOL_SEARCH_CONFIG,
      toolSearchRuntimeConfig: { tools: { toolSearch: { enabled: true, mode: "directory" } } },
      catalogRef,
    });

    expect(result.clientToolDefs.map((tool) => tool.name)).toEqual(["client_probe"]);
    expect(catalogRef.current?.entries.some((entry) => entry.source === "client")).toBe(false);
  });

  it.each([false, true])("binds side-effect owners unless client shadow is %s", (shadowed) => {
    const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);
    const tools = (shadowed ? ["memory_store"] : ["memory_store", "memory_forget"]).map((name) =>
      pluginTool(name, "memory-lancedb", { sideEffecting: true }),
    );
    const result = prepare({
      catalogRef,
      uncompactedEffectiveTools: tools,
      ...(shadowed ? { clientTools: [clientTool("Memory_Store")] } : {}),
    });
    if (shadowed) {
      expect(result.clientToolDefs.map((tool) => tool.name)).toEqual(["Memory_Store"]);
    }
    expect(result.sideEffectToolOwners).toEqual(
      new Map(
        shadowed
          ? []
          : [
              ["memory_store", '["memory-lancedb","memory_store"]'],
              ["memory_forget", '["memory-lancedb","memory_forget"]'],
            ],
      ),
    );
  });
});
