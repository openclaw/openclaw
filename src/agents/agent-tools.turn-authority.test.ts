import { describe, expect, it } from "vitest";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../../packages/agent-core/src/internal-hooks.js";
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability,
} from "./agent-tool-availability.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { isHostSystemTurn, resolveTurnToolSurface } from "./agent-tools.turn-authority.js";
import { expectOwnerGated } from "./agent-tools.turn-authority.test-support.js";
import { fakeTool } from "./test-helpers/fake-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { prepareCronToolArguments } from "./tools/cron-tool-canonicalize.js";

function tool(name: string): AnyAgentTool {
  return {
    ...fakeTool(name, `${name} tool`),
    execute: async () => ({ content: [], details: { ran: name } }),
  };
}

const surfaceFor = (turnTools: AnyAgentTool[], sessionTools = turnTools, hostSystemTurn = true) =>
  resolveTurnToolSurface({
    turnTools,
    sessionTools,
    hostSystemTurn,
    ownerOnlyDenied: new Set(["automations", "gateway"]),
  });

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
  const surface = (hostSystemTurn: boolean, prepareArguments?: AnyAgentTool["prepareArguments"]) =>
    surfaceFor(
      [{ ...tool("automations"), prepareArguments }, tool("gateway")],
      undefined,
      hostSystemTurn,
    );
  const run = (tools: AnyAgentTool[], name: string, args: object) => {
    return tools.find((entry) => entry.name === name)!.execute(`call-${name}`, args);
  };

  it.each([undefined, prepareCronToolArguments])(
    "serves scoped reads with native preparation %j",
    async (prepareArguments) => {
      const { tools, exportedTools, callableTools } = surface(true, prepareArguments);

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
    },
  );

  it("does not run unknown preparation for scheduler reads", async () => {
    const prepareArguments = () => {
      throw new Error("must not run");
    };
    const { tools } = surface(true, prepareArguments);
    await expect(run(tools, "automations", { action: "list" })).resolves.toMatchObject({
      details: { gated: true },
    });
    expect(tools.find((entry) => entry.name === "automations")?.prepareArguments).toBeUndefined();
  });

  it("keeps a completion handoff's requester denial over the scheduler reads", async () => {
    const { tools } = surfaceFor([tool("gateway")], [tool("automations"), tool("gateway")]);

    const result = await run(tools, "automations", { action: "list" });
    expect(result.details).toMatchObject({ gated: true });
  });

  it("runs scheduler reads on the turn-policy instance, not the session one", async () => {
    const turnInstance = tool("automations");
    const { tools } = surfaceFor(
      [turnInstance],
      [{ ...tool("automations"), execute: async () => ({ content: [], details: { session: 1 } }) }],
    );

    await expect(run(tools, "automations", { action: "runs" })).resolves.toMatchObject({
      details: { ran: "automations" },
    });
  });

  it.each([
    // Every host-started event turn takes one rule, whatever its source label.
    ["event", "internal_system", "cron", true],
    ["event", "internal_system", "cron_failure_repair", true],
    ["event", "internal_system", "exec", true],
    // Scheduled runs can carry hook-mapped external content.
    ["cron", "internal_system", "cron", false],
    ["user", "internal_system", "cron", false],
    [undefined, "internal_system", "cron", false],
    ["event", "inter_session", "cron", false],
  ] as const)(
    "recognizes trigger=%s provenance=%s/%s as a host system turn: %s",
    (trigger, kind, sourceTool, expected) => {
      // A full provenance record: its label must not change the rule.
      const inputProvenance: { kind: string; sourceTool: string } = { kind, sourceTool };
      expect(isHostSystemTurn({ trigger, inputProvenance })).toBe(expected);
    },
  );

  it("keeps automations fully owner-gated on a non-owner sender turn", async () => {
    const { tools } = surface(false);

    await expectOwnerGated(tools, "automations", "gateway");
    const result = await run(tools, "automations", { action: "get", jobId: "job-1" });
    expect(result.details).toMatchObject({ gated: true });
  });
});

it.each([
  [
    "a turn policy",
    (wrapped: AnyAgentTool) =>
      resolveTurnToolSurface({
        turnTools: [],
        sessionTools: [wrapped],
        outsideTurnReason: (name) => `${name} refused`,
        ownerOnlyDenied: new Set(),
      }).tools[0]!,
  ],
])("never hands the source's preparer to a tool %s refuses", async (_label, refuse) => {
  let ran = false;
  const source = fakeTool("exec", "exec");
  source.execute = async () => {
    ran = true;
    return { content: [{ type: "text", text: "ran" }], details: {} };
  };
  const wrapped = wrapToolWithBeforeToolCallHook(source);
  expect(getInternalToolExecutionPreparer(wrapped)).toBeDefined();
  const refused = refuse(wrapped);
  // The agent loop and the definition adapter prefer the preparer over execute.
  expect(getInternalToolExecutionPreparer(refused)).toBeUndefined();
  expect((await refused.execute("call", {})).details).toMatchObject({ gated: true });
  expect(ran).toBe(false);
});

it("keeps the scoped-reads split off the source preparer", () => {
  const source = fakeTool("automations", "automations");
  attachInternalToolExecutionPreparer(source, async () => {
    throw new Error("source preparer ran");
  });
  const [split] = resolveTurnToolSurface({
    turnTools: [source],
    ownerOnlyDenied: new Set(["automations"]),
    hostSystemTurn: true,
  }).tools;
  expect(getInternalToolExecutionPreparer(split!)).toBeUndefined();
});
