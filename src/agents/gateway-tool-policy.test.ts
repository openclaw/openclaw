import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { resetCodeModeTestState, runUntilCompleted } from "./code-mode.test-support.js";
import { applyGatewayToolPolicy } from "./gateway-tool-policy.js";
import { stringEnum } from "./schema/string-enum.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";

const config: OpenClawConfig = {
  tools: { gatewayPolicy: { allow: ["sessions"], actions: { sessions: ["list"] } } },
};

function actionTool() {
  return {
    ...createStubTool("sessions"),
    parameters: Type.Object({
      action: Type.Optional(stringEnum(["list", "patch"])),
      target: Type.String(),
    }),
    execute: vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: "completed" }], details: {} }),
  };
}

afterEach(async () => {
  await resetCodeModeTestState();
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("required Gateway tool policy", () => {
  it("projects only explicit actions while preserving the tool's other required arguments", () => {
    const [tool] = applyGatewayToolPolicy([actionTool()], config);
    const parameters = expectDefined(tool, "allowed action tool").parameters;
    expect(Value.Check(parameters, { action: "list", target: "main" })).toBe(true);
    expect(Value.Check(parameters, { action: "patch", target: "main" })).toBe(false);
    expect(Value.Check(parameters, { target: "main" })).toBe(false);
    expect(Value.Check(parameters, { action: "list" })).toBe(false);
  });

  it("rejects incomplete or unsupported action declarations instead of granting all actions", () => {
    expect(() =>
      applyGatewayToolPolicy([actionTool()], { tools: { gatewayPolicy: { allow: ["sessions"] } } }),
    ).toThrow("requires tools.gatewayPolicy.actions.sessions");
    expect(() => applyGatewayToolPolicy([createStubTool("sessions")], config)).toThrow(
      "top-level string action",
    );
  });

  it("normalizes tool aliases and honors an empty allowlist", () => {
    const tool = { ...actionTool(), name: "automations" };
    const [projected] = applyGatewayToolPolicy([tool, createStubTool("other")], {
      tools: { gatewayPolicy: { allow: ["cron"], actions: { cron: ["list"] } } },
    });
    expect(projected?.name).toBe("automations");
    expect(applyGatewayToolPolicy([tool], { tools: { gatewayPolicy: { allow: [] } } })).toEqual([]);
  });

  it.each(["search", "code-mode"] as const)(
    "keeps %s controls usable over only permitted targets",
    async (mode) => {
      const currentConfig: OpenClawConfig = { tools: { ...config.tools, toolSearch: true } };
      setRuntimeConfigSnapshot(currentConfig);
      const ctx = { config: currentConfig, catalogRef: createToolSearchCatalogRef() };
      const source = actionTool();
      const denied = { ...createStubTool("gateway"), execute: vi.fn() };
      const controls = mode === "search" ? createToolSearchTools(ctx) : createCodeModeTools(ctx);
      const compact = mode === "search" ? applyToolSearchCatalog : applyCodeModeCatalog;
      const surface = compact({
        ...ctx,
        tools: [...controls, source, denied],
        toolHookContext: { config: currentConfig },
      });
      const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(currentConfig));
      expect(runtime.all().map((entry) => entry.name)).toEqual(["sessions"]);
      expect((await runtime.describe("sessions")).parameters).toMatchObject({
        properties: { action: { enum: ["list"] } },
      });
      if (mode === "search") {
        const call = expectDefined(
          surface.tools.find((tool) => tool.name === "dispatch_action"),
          "dispatch control",
        );
        await call.execute("allowed", { id: "sessions", args: { action: "list", target: "main" } });
        await expect(call.execute("denied", { id: "gateway", args: {} })).rejects.toThrow();
      } else {
        const result = await runUntilCompleted({
          execTool: expectDefined(
            surface.tools.find((tool) => tool.name === "exec"),
            "Code Mode exec",
          ),
          waitTool: expectDefined(
            surface.tools.find((tool) => tool.name === "wait"),
            "Code Mode wait",
          ),
          code: 'await sessions({ action: "list", target: "main" }); return typeof gateway;',
        });
        expect(result).toMatchObject({ status: "completed", value: "undefined" });
      }
      expect(source.execute).toHaveBeenCalledTimes(1);
      expect(denied.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["finalized", "compacted"] as const)(
    "checks final hook arguments on %s tools with assembly config",
    async (assembly) => {
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "fixture",
        hookName: "before_tool_call",
        handler: async () => ({ params: { action: "patch", target: "main" } }),
      });
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      const source = actionTool();
      // No global snapshot: the assembly config must reach the execution wrapper.
      const prewrapped = wrapToolWithBeforeToolCallHook(source);
      let execute: () => Promise<unknown>;
      if (assembly === "compacted") {
        const catalogRef = createToolSearchCatalogRef();
        applyToolSearchCatalog({
          config: { tools: { ...config.tools, toolSearch: true } },
          catalogRef,
          tools: [...createToolSearchTools({ catalogRef }), prewrapped],
          toolHookContext: {},
        });
        const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config));
        execute = () => runtime.call("sessions", { action: "list", target: "main" });
      } else {
        const tool = expectDefined(
          finalizeAgentTools({ tools: [prewrapped], config, hookContext: {} })[0],
          "finalized tool",
        );
        execute = () =>
          Promise.resolve(tool.execute("rewritten", { action: "list", target: "main" }));
      }
      await expect(execute()).rejects.toThrow("Gateway tool policy denies");
      expect(source.execute).not.toHaveBeenCalled();
    },
  );

  it("captures each headless catalog's deployment policy without a hook context", async () => {
    const source = actionTool();
    const buildRuntime = () => {
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [source] });
      return new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config));
    };
    setRuntimeConfigSnapshot(config);
    const original = buildRuntime();
    setRuntimeConfigSnapshot({
      tools: { gatewayPolicy: { allow: ["sessions"], actions: { sessions: ["patch"] } } },
    });
    const replacement = buildRuntime();

    expect((await original.describe("sessions")).parameters).toMatchObject({
      properties: { action: { enum: ["list"] } },
    });
    expect((await replacement.describe("sessions")).parameters).toMatchObject({
      properties: { action: { enum: ["patch"] } },
    });
    await original.call("sessions", { action: "list", target: "main" });
    await replacement.call("sessions", { action: "patch", target: "main" });
    await expect(original.call("sessions", { action: "patch", target: "main" })).rejects.toThrow(
      "Gateway tool policy denies",
    );
    await expect(replacement.call("sessions", { action: "list", target: "main" })).rejects.toThrow(
      "Gateway tool policy denies",
    );
    expect(source.execute).toHaveBeenCalledTimes(2);
  });

  it("preserves ordinary tool execution when deployment policy is absent", async () => {
    const source = actionTool();
    const [projected] = applyGatewayToolPolicy([source], {});
    expect(projected).toBe(source);
    const tool = wrapToolWithBeforeToolCallHook(source, { config: {} });
    await tool.execute("ordinary", { action: "patch", target: "main" });
    expect(source.execute).toHaveBeenCalledOnce();
  });
});
