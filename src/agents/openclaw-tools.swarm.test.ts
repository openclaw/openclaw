import { describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", () => ({ resolveOpenClawPluginToolsForOptions: () => [] }));
function createSwarmTools(options: NonNullable<Parameters<typeof createOpenClawTools>[0]>) {
  const config = options.config ?? {};
  return createOpenClawTools({
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
    config: { ...config, agents: config.agents ?? { entries: { main: { default: true } } } },
  });
}
function collectorTools(options: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>) {
  return createOpenClawCodingTools({
    sessionKey: "agent:worker:main",
    runId: "collector-run",
    swarmCollector: true,
    config: { agents: { entries: { main: { default: true } } }, tools: { swarm: true } },
    ...options,
  }).map((tool) => tool.name);
}

describe("Swarm registration", () => {
  it.each([
    { profile: "coding", wait: true },
    { profile: "messaging", wait: false },
  ] as const)("keeps default Swarm within the $profile tool profile", ({ profile, wait }) => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:main",
      config: { agents: { entries: { main: { default: true } } }, tools: { profile } },
    });
    expect(tools.some((tool) => tool.name === "agents_wait")).toBe(wait);
    const spawn = tools.find((tool) => tool.name === "sessions_spawn");
    expect(spawn?.parameters).toHaveProperty("properties.fastMode");
    for (const field of ["collect", "outputSchema", "groupId"]) {
      if (wait) {
        expect(spawn?.parameters).toHaveProperty(`properties.${field}`);
      } else {
        expect(spawn?.parameters).not.toHaveProperty(`properties.${field}`);
      }
    }
    if (!wait) {
      expect(JSON.stringify(spawn?.parameters)).not.toContain("collect=true");
    }
  });

  it("uses the effective requester override for the agents_wait gate", () => {
    const base = { agentSessionKey: "agent:worker:main", requesterAgentIdOverride: "worker" };
    for (const enabled of [true, false]) {
      const tools = createSwarmTools({
        ...base,
        config: {
          tools: { swarm: !enabled },
          agents: { entries: { main: {}, worker: { tools: { swarm: enabled } } } },
        },
      });
      expect(tools.some((tool) => tool.name === "agents_wait")).toBe(enabled);
    }
  });

  it("advertises sessions_spawn from agents_wait only when spawn is available", () => {
    setEmbeddedMode(true);
    try {
      for (const available of [false, true]) {
        const tools = applyToolAvailabilityDescriptions(
          createSwarmTools({
            agentSessionKey: "agent:main:main",
            allowGatewaySubagentBinding: available,
            config: { tools: { swarm: true } },
          }),
        );
        expect(tools.some((tool) => tool.name === "sessions_spawn")).toBe(available);
        expect(
          tools.find((tool) => tool.name === "agents_wait")?.description.includes("sessions_spawn"),
        ).toBe(available);
      }
    } finally {
      setEmbeddedMode(false);
    }
  });

  it("retains structured output through restrictive collector tool policy", () => {
    const names = collectorTools({
      sessionKey: "agent:worker:subagent:child",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { allow: ["read"], swarm: true },
      },
      swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
    });
    expect(names).toContain("read");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("exec");
  });

  it("withholds requester interaction and schema output from a text collector", () => {
    const names = collectorTools({});
    for (const name of [
      "message",
      "ask_user",
      "sessions_send",
      "sessions_yield",
      "structured_output",
    ]) {
      expect(names).not.toContain(name);
    }
  });

  it("omits the message tool for collector runs by invariant", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("message");
  });
});
