import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability,
} from "./agent-tool-availability.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { resolveTurnToolSurface } from "./agent-tools.turn-authority.js";
import { getInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import type { AnyAgentTool } from "./tools/common.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: { ran: name } }),
  };
}

describe("resolveTurnToolSurface", () => {
  it("does not copy a source execution preparer onto an authority denial", async () => {
    const calls: string[] = [];
    const source = wrapToolWithBeforeToolCallHook({
      ...tool("gateway"),
      prepareBeforeToolCallParams: async (args) => {
        calls.push("prepare");
        return args;
      },
      execute: async () => {
        calls.push("execute");
        return { content: [], details: {} };
      },
    });
    expect(getInternalToolExecutionPreparer(source)).toBeTypeOf("function");
    const { tools } = resolveTurnToolSurface({
      turnTools: [source],
      ownerOnlyDenied: new Set(["gateway"]),
    });
    const denied = wrapToolWithBeforeToolCallHook(tools[0]!);
    const prepare = getInternalToolExecutionPreparer(denied);
    expect(prepare).toBeTypeOf("function");
    const result = await prepare!({ toolCallId: "denied", args: {} });
    if (result.kind === "ready") {
      await result.execute();
    }
    result.dispose();
    expect(calls).toEqual([]);
  });
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
