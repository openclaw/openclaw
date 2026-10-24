import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { isAgentToolRestartSafe } from "./tool-replay-safety.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "./tool-search-types.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchCatalogRef,
} from "./tool-search.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as gateway from "./tools/gateway.js";
import "./test-helpers/fast-coding-tools.js";

const sessionKey = "agent:main:recovery-reader";
const config: OpenClawConfig = {
  tools: {
    allow: ["automations", "exec"],
    toolSearch: { enabled: true, mode: "tools" },
  },
};
const job: CronJob = {
  id: "watcher-record",
  name: "Application errors",
  enabled: false,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  schedule: { kind: "stream", command: ["tail", "-F", "/synthetic/application.log"] },
  sessionTarget: "current",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Report application errors." },
  state: { streamStatus: "running" },
};
const emptyPage = {
  jobs: [],
  total: 0,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};
const unavailableRecoveryInputs = [
  { action: "status" },
  {
    action: "add",
    job: {
      name: "Replacement",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "systemEvent", text: "Synthetic reminder" },
    },
  },
  { action: "update", jobId: job.id, job: { enabled: true } },
  { action: "remove", jobId: job.id },
  { action: "run", jobId: job.id },
  { action: "wake", text: "Resume work" },
  { action: "next_check", jobId: job.id, in: "15m" },
] as const;
const gatewayCall = vi.fn<typeof gateway.callGatewayTool>();
const catalogs: ToolSearchCatalogRef[] = [];

beforeEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  setRuntimeConfigSnapshot(config);
  gatewayCall.mockReset();
  vi.spyOn(gateway, "callGatewayTool").mockImplementation(gatewayCall);
});

afterEach(async () => {
  for (const catalogRef of catalogs.splice(0)) {
    clearToolSearchCatalog({ catalogRef });
  }
  await resetCodeModeTestState();
  resetGlobalHookRunner();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

function construct(options: Partial<OpenClawCodingToolsOptions> = {}) {
  const catalogRef = createToolSearchCatalogRef();
  catalogs.push(catalogRef);
  const tools = createOpenClawCodingToolsInternal({
    config,
    agentId: "main",
    sessionKey,
    workspaceDir: "/tmp",
    // Automatic recovery has no fresh owner or automation-management grant.
    senderIsOwner: false,
    forceRestartSafeTools: true,
    includeToolSearchControls: true,
    toolSearchCatalogRef: catalogRef,
    emitBeforeToolCallDiagnostics: false,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
    ...options,
  });
  const retained = tools.filter((tool) =>
    isAgentToolRestartSafe(tool, {
      declaredReplaySafe: () => {
        const plugin = getPluginToolMeta(tool);
        if (plugin) {
          return !plugin.mcp && plugin.replaySafe === true;
        }
        return getChannelAgentToolMeta(tool) ? false : undefined;
      },
    }),
  );
  const catalog = applyToolSearchCatalog({
    tools: retained,
    config: options.config ?? config,
    catalogRef,
  });
  const call = expectDefined(
    catalog.tools.find((tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME),
    TOOL_CALL_RAW_TOOL_NAME,
  );
  return {
    tools,
    retained,
    catalogRef,
    automation: () =>
      expectDefined(
        tools.find((tool) => tool.name === "automations"),
        "automations",
      ),
    call: (args: Record<string, unknown>, id = "automations") =>
      call.execute("recovery-inspection", { id, args }),
  };
}

describe("restart-safe automation inspection", () => {
  it("reads the owner's recorded status through the restart-safe dispatcher catalog", async () => {
    const surface = construct();
    gatewayCall.mockImplementation(async <T>(method: string) => {
      expect(method).toBe("cron.get");
      expect(getGatewayToolCallerIdentity()).toMatchObject({ agentId: "main", sessionKey });
      return job as T;
    });

    const result = await surface.call({ action: "get", jobId: job.id });

    expect(result.details).toMatchObject({
      tool: { name: "automations" },
      result: { details: { id: job.id, enabled: false, state: { streamStatus: "running" } } },
    });
    expect(gatewayCall).toHaveBeenCalledOnce();
    expect(surface.retained.some((tool) => tool.name === "exec")).toBe(false);
    await expect(surface.call({ command: "echo forbidden" }, "exec")).rejects.toThrow();
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("preserves filtered absence and failed lookups without inventing an operation outcome", async () => {
    const surface = construct();
    gatewayCall.mockResolvedValueOnce(emptyPage);
    const listed = await surface.call({ action: "list", includeDisabled: true });
    expect(listed.details).toMatchObject({
      result: {
        details: {
          jobs: [],
          includeDisabled: true,
          scope: "caller",
          inventoryHint: expect.stringContaining(
            "Absence does not prove deletion or source termination",
          ),
        },
      },
    });
    expect(gatewayCall).toHaveBeenLastCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      compact: true,
    });
    gatewayCall.mockRejectedValueOnce(new Error("Recorded outcome unavailable"));
    await expect(surface.call({ action: "get", jobId: job.id })).rejects.toThrow(
      "Recorded outcome unavailable",
    );
    expect(gatewayCall).toHaveBeenCalledTimes(2);
  });

  it("rejects global status and every automation mutation at the owner even with open admission", async () => {
    const surface = construct();
    const automation = surface.automation();
    expect(Value.Check(automation.parameters, { action: "get", jobId: job.id })).toBe(true);
    for (const args of unavailableRecoveryInputs) {
      expect(Value.Check(automation.parameters, args), args.action).toBe(false);
      // Direct invocation exercises the owner guard independently of catalog schema validation.
      await expect(automation.execute(`forbidden-${args.action}`, args)).rejects.toThrow(
        /read-only/i,
      );
      await expect(surface.call(args)).rejects.toThrow();
    }
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("rejects a hook rewriting an allowed read into a mutation at final execution", async () => {
    const surface = construct();
    const rewrite = vi.fn((event: unknown) =>
      isRecord(event) && event.toolName === "automations"
        ? { params: { action: "remove", jobId: job.id } }
        : undefined,
    );
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: rewrite }]),
    );
    const automation = surface.automation();
    await expect(
      automation.execute("rewritten-read", { action: "get", jobId: job.id }),
    ).rejects.toThrow(/read-only/i);
    expect(rewrite).toHaveBeenCalled();
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("keeps explicit user denial ahead of recovery availability", async () => {
    const surface = construct({ config: { tools: { ...config.tools, deny: ["automations"] } } });
    expect(surface.tools.some((tool) => tool.name === "automations")).toBe(false);
    await expect(surface.call({ action: "get", jobId: job.id })).rejects.toThrow();
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("retains the scheduled run's exact-job restriction while removing cleanup writes", async () => {
    const surface = construct({ trigger: "cron", jobId: job.id });
    gatewayCall.mockResolvedValue(job);
    await surface.call({ action: "get", jobId: job.id });
    await expect(surface.call({ action: "get", jobId: "another-job" })).rejects.toThrow(
      "restricted to the current automation",
    );
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("requires caller identity for recovery reads and owner authority for normal writes", async () => {
    for (const options of [{ sessionKey: undefined }, { forceRestartSafeTools: false }]) {
      const denied = construct(options);
      await expect(
        denied.automation().execute("denied-recovery-read", { action: "get", jobId: job.id }),
      ).resolves.toMatchObject({ details: { gated: true } });
    }
    expect(gatewayCall).not.toHaveBeenCalled();
    const surface = construct({ forceRestartSafeTools: false, senderIsOwner: true });
    const automation = surface.automation();
    expect(isAgentToolRestartSafe(automation)).toBe(false);
    expect(Value.Check(automation.parameters, { action: "remove", jobId: job.id })).toBe(true);
    gatewayCall
      .mockResolvedValueOnce({ ...job, configRevision: `sha256:${"a".repeat(64)}` })
      .mockResolvedValueOnce({ ok: true, removed: true });
    const result = await automation.execute("normal-removal", { action: "remove", jobId: job.id });
    expect(result.details).toMatchObject({ ok: true, removed: true });
    expect(gatewayCall.mock.calls.map(([method]) => method)).toEqual(["cron.get", "cron.remove"]);
  });

  it("allows owner reads in forced restart-safe Code Mode without admitting a later write", async () => {
    const surface = construct();
    const harness = createCodeModeHarness({
      catalogRef: surface.catalogRef,
      forceRestartSafeTools: true,
    });
    registerHeadlessToolSearchCatalog({ catalogRef: surface.catalogRef, tools: surface.retained });
    gatewayCall.mockResolvedValue(job);
    const result = await runUntilCompleted({
      execTool: expectDefined(harness.tools[0], "Code Mode exec"),
      waitTool: expectDefined(harness.tools[1], "Code Mode wait"),
      restartSafe: false,
      code: `const observed = await automations({action:"get",jobId:"watcher-record"});
        let refused = false;
        try { await automations({action:"remove",jobId:"watcher-record"}); } catch { refused = true; }
        return { observed, refused };`,
    });
    expect(result).toMatchObject({
      status: "completed",
      replaySafe: true,
      value: { observed: { id: job.id, state: { streamStatus: "running" } }, refused: true },
    });
    expect(gatewayCall).toHaveBeenCalledOnce();
  });
});
