import { describe, expect, it } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { buildAgentFilterOptions, buildAssignableAgentPickerOptions } from "./agent-filter.ts";

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Main" },
    { id: "ordinary-looking-id", kind: "system", name: "System" },
    { id: "research", name: "Research" },
  ],
};

describe("workboard agent options", () => {
  it.each([
    { roster: null, label: "writer" },
    { roster: agentsList, label: "writer (not configured)" },
    {
      roster: { ...agentsList, agents: [...agentsList.agents, { id: "writer", name: "Writer" }] },
      label: "Writer",
    },
  ])("retains the current assignment as $label", ({ roster, label }) => {
    const options = buildAssignableAgentPickerOptions(roster, "writer", "main");
    expect(options.find((option) => option.value === "writer")).toMatchObject({
      label,
      agent: { id: "writer" },
    });
    expect(options[0]).toMatchObject({ value: "", badge: "Default", agent: { id: "main" } });
  });
  it("excludes system agents from assignment but retains diagnostic filtering", () => {
    expect(buildAssignableAgentPickerOptions(agentsList, "").map((option) => option.value)).toEqual(
      ["", "main", "research"],
    );
    expect(
      buildAssignableAgentPickerOptions(agentsList, "ordinary-looking-id").map(
        (option) => option.value,
      ),
    ).toEqual(["", "main", "research"]);
    expect(buildAgentFilterOptions(agentsList, []).map((option) => option.id)).toContain(
      "ordinary-looking-id",
    );
  });
});
