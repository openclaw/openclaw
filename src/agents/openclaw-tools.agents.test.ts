// Verifies agents_list reports only subagents visible to the requester.
import { describe, expect, it, vi } from "vitest";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";

let configOverride: ReturnType<(typeof import("../config/config.js"))["getRuntimeConfig"]> = {
  session: createPerSenderSessionConfig(),
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

describe("agents_list", () => {
  type AgentConfig = NonNullable<NonNullable<typeof configOverride.agents>["list"]>[number];

  function setConfigWithAgentList(agentList: AgentConfig[]) {
    // Each test gets a fresh per-sender session config plus its agent list.
    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        list: agentList,
      },
    };
  }

  function createTool() {
    return createAgentsListTool({
      agentSessionKey: "agent:main:main",
    });
  }

  function readAgentList(result: unknown) {
    // Tool results expose the machine-readable agent list in details.
    return (result as { details?: { agents?: Array<{ id: string; configured?: boolean }> } })
      .details?.agents;
  }

  it("defaults to the requester when no agents are configured", async () => {
    configOverride = { session: createPerSenderSessionConfig() };
    const result = await createTool().execute("default", {});
    expect(result.details).toMatchObject({ requester: "main", allowAny: false });
    expect(readAgentList(result)?.map((agent) => agent.id)).toEqual(["main"]);
  });

  it("omits allowlisted targets that are not configured", async () => {
    setConfigWithAgentList([{ id: "main", subagents: { allowAgents: ["research"] } }]);
    expect(readAgentList(await createTool().execute("stale", {}))).toEqual([]);
  });

  it("returns configured agents when allowlist is *", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        subagents: {
          allowAgents: ["*"],
        },
      },
      {
        id: "research",
        name: "Research",
      },
      {
        id: "coder",
        name: "Coder",
      },
    ]);

    const tool = createTool();
    const result = await tool.execute("call3", {});
    const details = result.details as { allowAny?: boolean };
    expect(details.allowAny).toBe(true);
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "coder", "research"]);
  });
});
