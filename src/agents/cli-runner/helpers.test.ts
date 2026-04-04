import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildSystemPrompt } from "./helpers.js";

function makeConfig(
  systemPrompt: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number]["systemPrompt"],
): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "writer",
          systemPrompt,
        },
      ],
    },
  };
}

describe("cli runner system prompt", () => {
  it("applies per-agent custom prompt overrides for normal CLI sessions", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: makeConfig({
        mode: "custom",
        sections: ["runtime"],
      }),
      tools: [],
      modelDisplay: "openai/gpt-5.4",
      sessionKey: "agent:writer:main",
      agentId: "writer",
    });

    expect(prompt).toContain("## Runtime");
    expect(prompt).not.toContain("## Tooling");
    expect(prompt).not.toContain("## Safety");
  });

  it("respects explicit none overrides for minimal CLI sessions", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: makeConfig({
        mode: "none",
      }),
      tools: [],
      modelDisplay: "openai/gpt-5.4",
      sessionKey: "agent:writer:subagent:child",
      agentId: "writer",
    });

    expect(prompt).toBe("You are a personal assistant running inside OpenClaw.");
  });
});
