import { describe, expect, it } from "vitest";
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability,
} from "./agent-tool-availability.js";
import { isSchedulerSystemTurn, resolveTurnToolSurface } from "./agent-tools.turn-authority.js";
import { expectOwnerGated } from "./agent-tools.turn-authority.test-support.js";
import type { AnyAgentTool } from "./tools/common.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: { ran: name } }),
  } as unknown as AnyAgentTool;
}

describe("resolveTurnToolSurface", () => {
  it("keeps a gated dependency non-callable for dependent affordances", () => {
    // A spawn tool may enable result collection only while its reader is callable.
    let readerCallable: boolean | undefined;
    const reader = bindAgentToolAvailability(tool("agents_wait"), { prepare: () => {} });
    const spawn = bindAgentToolAvailability(tool("sessions_spawn"), {
      prepare: (_tool, callable) => {
        readerCallable = callable.has("agents_wait");
      },
    });
    const { tools } = resolveTurnToolSurface({
      turnTools: [spawn],
      sessionTools: [spawn, reader],
      ownerOnlyDenied: new Set(),
    });

    expect(tools.map((entry) => entry.name)).toEqual(["sessions_spawn", "agents_wait"]);
    finalizeAgentToolAvailability(tools);
    expect(readerCallable).toBe(false);
  });
});

describe("resolveTurnToolSurface on a system turn", () => {
  const surface = (schedulerSystemTurn: boolean) =>
    resolveTurnToolSurface({
      turnTools: [tool("automations"), tool("gateway")],
      ownerOnlyDenied: new Set(["automations", "gateway"]),
      schedulerSystemTurn,
    });
  const run = (tools: AnyAgentTool[], name: string, args: object) => {
    const target = tools.find((entry) => entry.name === name);
    const execute = target?.execute as (
      id: string,
      input: object,
    ) => Promise<{ details?: unknown }>;
    return execute(`call-${name}`, args);
  };

  it("serves caller-scoped automation reads and keeps every write owner-gated", async () => {
    const { tools, exportedTools, callableTools } = surface(true);

    for (const action of ["list", "get", " runs "]) {
      await expect(run(tools, "automations", { action, jobId: "job-1" })).resolves.toMatchObject({
        details: { ran: "automations" },
      });
    }
    for (const action of ["status", "add", "update", "remove", "run", "wake", undefined]) {
      const result = await run(tools, "automations", { action });
      expect(result.details).toMatchObject({ gated: true });
    }
    await expectOwnerGated(tools, "gateway");
    // Descendants never inherit the system turn's partial access.
    expect(exportedTools.map((entry) => entry.name)).toEqual([]);
    expect(callableTools.map((entry) => entry.name)).toEqual([]);
  });

  it("keeps a completion handoff's requester denial over the scheduler reads", async () => {
    const { tools } = resolveTurnToolSurface({
      turnTools: [tool("gateway")],
      sessionTools: [tool("automations"), tool("gateway")],
      ownerOnlyDenied: new Set(["automations", "gateway"]),
      schedulerSystemTurn: true,
    });

    const result = await run(tools, "automations", { action: "list" });
    expect(result.details).toMatchObject({ gated: true });
  });

  it("runs scheduler reads on the turn-policy instance, not the session one", async () => {
    const turnInstance = tool("automations");
    const { tools } = resolveTurnToolSurface({
      turnTools: [turnInstance],
      sessionTools: [
        { ...tool("automations"), execute: async () => ({ content: [], details: { session: 1 } }) },
      ] as AnyAgentTool[],
      ownerOnlyDenied: new Set(["automations"]),
      schedulerSystemTurn: true,
    });

    await expect(run(tools, "automations", { action: "runs" })).resolves.toMatchObject({
      details: { ran: "automations" },
    });
  });

  it.each([
    ["event", "internal_system", "cron", true],
    // Scheduled runs can carry hook-mapped external content.
    ["cron", "internal_system", "cron", false],
    ["user", "internal_system", "cron", false],
    [undefined, "internal_system", "cron", false],
    ["event", "internal_system", "exec", false],
    ["event", "inter_session", "cron", false],
  ] as const)(
    "recognizes trigger=%s provenance=%s/%s as a scheduler turn: %s",
    (trigger, kind, sourceTool, expected) => {
      expect(isSchedulerSystemTurn({ trigger, inputProvenance: { kind, sourceTool } })).toBe(
        expected,
      );
    },
  );

  it("keeps automations fully owner-gated on a non-owner sender turn", async () => {
    const { tools } = surface(false);

    await expectOwnerGated(tools, "automations", "gateway");
    const result = await run(tools, "automations", { action: "get", jobId: "job-1" });
    expect(result.details).toMatchObject({ gated: true });
  });
});
