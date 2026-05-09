import { describe, expect, it } from "vitest";
import { buildCliAgentSystemPrompt } from "./helpers.js";

describe("buildCliAgentSystemPrompt", () => {
  it("uses config-backed sub-agent delegation mode", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      tools: [{ name: "sessions_spawn" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
  });
});
