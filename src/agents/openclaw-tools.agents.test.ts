import { beforeEach, describe, expect, it, vi } from "vitest";

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("agents_list", () => {
  beforeEach(() => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("defaults to the requester agent only", async () => {
    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }

    const result = await tool.execute("call1", {});
    expect(result.details).toMatchObject({
      requester: "main",
      allowAny: false,
    });
    const agents = (result.details as { agents?: Array<{ id: string }> }).agents;
    expect(agents?.map((agent) => agent.id)).toEqual(["main"]);
  });

  it("includes allowlisted targets plus requester", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
            subagents: {
              allowAgents: ["research"],
            },
          },
          {
            id: "research",
            name: "Research",
          },
        ],
      },
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }

    const result = await tool.execute("call2", {});
    const agents = (
      result.details as {
        agents?: Array<{ id: string }>;
      }
    ).agents;
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "research"]);
  });

  it("returns configured agents when allowlist is *", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
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
        ],
      },
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }

    const result = await tool.execute("call3", {});
    expect(result.details).toMatchObject({
      allowAny: true,
    });
    const agents = (
      result.details as {
        agents?: Array<{ id: string }>;
      }
    ).agents;
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "coder", "research"]);
  });

  it("marks allowlisted-but-unconfigured agents", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["research"],
            },
          },
        ],
      },
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }

    const result = await tool.execute("call4", {});
    const agents = (
      result.details as {
        agents?: Array<{ id: string; configured: boolean }>;
      }
    ).agents;
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "research"]);
    const research = agents?.find((agent) => agent.id === "research");
    expect(research?.configured).toBe(false);
  });

  it("includes description when configured", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            description: "Orchestrates all sub-agents",
            subagents: {
              allowAgents: ["research"],
            },
          },
          {
            id: "research",
            name: "Research Agent",
            description: "Web research, market analysis, data gathering",
          },
        ],
      },
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }

    const result = await tool.execute("call5", {});
    const agents = (
      result.details as {
        agents?: Array<{ id: string; name?: string; description?: string }>;
      }
    ).agents;
    expect(agents).toHaveLength(2);
    const mainAgent = agents?.find((agent) => agent.id === "main");
    expect(mainAgent?.name).toBe("Main Agent");
    expect(mainAgent?.description).toBe("Orchestrates all sub-agents");
    const researchAgent = agents?.find((agent) => agent.id === "research");
    expect(researchAgent?.name).toBe("Research Agent");
    expect(researchAgent?.description).toBe("Web research, market analysis, data gathering");
  });

  it("omits description when not configured", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            subagents: {
              allowAgents: ["*"],
            },
          },
          {
            id: "nodesc",
            name: "No Description Agent",
          },
        ],
      },
    };

    const tool = createOpenClawTools({
      agentSessionKey: "main",
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }

    const result = await tool.execute("call6", {});
    const agents = (
      result.details as {
        agents?: Array<{ id: string; description?: string }>;
      }
    ).agents;
    const nodescAgent = agents?.find((agent) => agent.id === "nodesc");
    expect(nodescAgent?.description).toBeUndefined();
  });
});
