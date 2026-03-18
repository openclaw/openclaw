import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: createPerSenderSessionConfig(),
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
  type AgentConfig = NonNullable<NonNullable<typeof configOverride.agents>["list"]>[number];

  async function seedRegistryFixture(): Promise<void> {
    const { resolveOperatorReferenceSourcePath } =
      await import("../operator-control/reference-paths.js");
    const { invalidateRegistryCache } = await import("../operator-control/agent-registry.js");
    const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      [
        "agents:",
        "  - id: bobby-digital",
        "    name: Bobby Digital",
        "    specialty: Engineering",
        "    triggers: [engineering]",
        "  - id: method-man",
        "    name: Method Man",
        "    specialty: Frontend",
        "    triggers: [frontend, ui]",
        "teams:",
        "  - id: engineering",
        "    name: Engineering",
        "    lead: bobby-digital",
        "    members: [bobby-digital]",
        "    route_via_lead: true",
        "  - id: frontend",
        "    name: Frontend",
        "    parent_team_id: engineering",
        "    lead: method-man",
        "    members: [method-man]",
        "    owns_capabilities: [frontend, ui]",
        "",
      ].join("\n"),
      "utf8",
    );
    invalidateRegistryCache({ sourcePath });
  }

  function setConfigWithAgentList(agentList: AgentConfig[]) {
    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        list: agentList,
      },
    };
  }

  async function createReadyAgent(
    rootDir: string,
    params: {
      id: string;
      name?: string;
      subagents?: AgentConfig["subagents"];
    },
  ): Promise<AgentConfig> {
    const workspace = path.join(rootDir, params.id);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "AGENTS.md"), `# ${params.id}\n`, "utf8");
    return {
      id: params.id,
      ...(params.name ? { name: params.name } : {}),
      workspace,
      ...(params.subagents ? { subagents: params.subagents } : {}),
    };
  }

  function requireAgentsListTool(agentSessionKey = "main") {
    const tool = createOpenClawTools({
      agentSessionKey,
    }).find((candidate) => candidate.name === "agents_list");
    if (!tool) {
      throw new Error("missing agents_list tool");
    }
    return tool;
  }

  function readAgentList(result: unknown) {
    return (result as { details?: { agents?: Array<{ id: string; configured?: boolean }> } })
      .details?.agents;
  }

  beforeEach(() => {
    configOverride = {
      session: createPerSenderSessionConfig(),
    };
  });

  it("returns only the requester when no ready helper runtime exists", async () => {
    const tool = requireAgentsListTool();
    const result = await tool.execute("call1", {});
    expect(result.details).toMatchObject({
      requester: "main",
      allowAny: false,
    });
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main"]);
  });

  it("includes allowlisted targets plus Scout", async () => {
    await withTempDir("agents-list-workspaces-", async (rootDir) => {
      setConfigWithAgentList([
        await createReadyAgent(rootDir, {
          id: "main",
          name: "Main",
          subagents: {
            allowAgents: ["research"],
          },
        }),
        await createReadyAgent(rootDir, {
          id: "research",
          name: "Research",
        }),
        await createReadyAgent(rootDir, {
          id: "scout",
          name: "Scout",
        }),
      ]);

      const tool = requireAgentsListTool();
      const result = await tool.execute("call2", {});
      const agents = readAgentList(result);
      expect(agents?.map((agent) => agent.id)).toEqual(["main", "research", "scout"]);
    });
  });

  it("returns configured agents plus Scout when allowlist is *", async () => {
    await withTempDir("agents-list-allow-any-", async (rootDir) => {
      setConfigWithAgentList([
        await createReadyAgent(rootDir, {
          id: "main",
          subagents: {
            allowAgents: ["*"],
          },
        }),
        await createReadyAgent(rootDir, {
          id: "research",
          name: "Research",
        }),
        await createReadyAgent(rootDir, {
          id: "coder",
          name: "Coder",
        }),
        await createReadyAgent(rootDir, {
          id: "scout",
          name: "Scout",
        }),
      ]);

      const tool = requireAgentsListTool();
      const result = await tool.execute("call3", {});
      expect(result.details).toMatchObject({
        allowAny: true,
      });
      const agents = readAgentList(result);
      expect(agents?.map((agent) => agent.id)).toEqual(["main", "coder", "research", "scout"]);
    });
  });

  it("hides allowlisted targets that are not runtime-ready", async () => {
    await withTempDir("agents-list-hide-unready-", async (rootDir) => {
      setConfigWithAgentList([
        await createReadyAgent(rootDir, {
          id: "main",
          subagents: {
            allowAgents: ["research"],
          },
        }),
        await createReadyAgent(rootDir, {
          id: "scout",
          name: "Scout",
        }),
      ]);

      const tool = requireAgentsListTool();
      const result = await tool.execute("call4", {});
      const agents = readAgentList(result);
      expect(agents?.map((agent) => agent.id)).toEqual(["main", "scout"]);
      expect(agents?.find((agent) => agent.id === "research")).toBeUndefined();
    });
  });

  it("shows Scout for unconfigured specialist requesters", async () => {
    await withTempDir("agents-list-specialist-scout-", async (rootDir) => {
      setConfigWithAgentList([
        await createReadyAgent(rootDir, {
          id: "scout",
          name: "Scout",
        }),
      ]);

      const tool = requireAgentsListTool("agent:method-man:main");
      const result = await tool.execute("call-specialist", {});
      expect(result.details).toMatchObject({
        requester: "method-man",
        allowAny: false,
      });
      const agents = readAgentList(result);
      expect(agents?.map((agent) => agent.id)).toEqual(["method-man", "scout"]);
    });
  });

  it("includes caller-scoped team metadata when the operator registry is available", async () => {
    await withStateDirEnv("agents-list-teams-", async () => {
      await withTempDir("agents-list-team-workspaces-", async (rootDir) => {
        await seedRegistryFixture();
        setConfigWithAgentList([
          await createReadyAgent(rootDir, {
            id: "bobby-digital",
            name: "Bobby",
            subagents: {
              allowAgents: ["method-man"],
            },
          }),
          await createReadyAgent(rootDir, {
            id: "method-man",
            name: "Method",
          }),
        ]);

        const tool = createOpenClawTools({
          agentSessionKey: "agent:bobby-digital:main",
        }).find((candidate) => candidate.name === "agents_list");
        if (!tool) {
          throw new Error("missing agents_list tool");
        }

        const result = await tool.execute("call-teams", {});
        expect((result as { details?: { teams?: unknown[] } }).details?.teams).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "engineering" }),
            expect.objectContaining({ id: "frontend" }),
          ]),
        );
      });
    });
  });
});
