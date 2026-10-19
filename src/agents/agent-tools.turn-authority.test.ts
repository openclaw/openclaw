import { describe, expect, it } from "vitest";
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability,
} from "./agent-tool-availability.js";
import { resolveTurnToolSurface } from "./agent-tools.turn-authority.js";
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
