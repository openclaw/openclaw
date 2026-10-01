/** Tests model-facing descriptions selected from the final authorized tool set. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import {
  describeSessionsSearchTool,
  describeSessionsSendTool,
  describeSessionsSpawnTool,
} from "./tool-description-presets.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { createConversationsSendTool } from "./tools/conversation-tools.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

function findToolDescription(
  toolName: string,
  schedulerToolName?: "automations" | "cron",
  hasProcessTool = true,
) {
  const tools = withMockedPlatform("linux", () =>
    applyToolAvailabilityDescriptions([
      { name: "exec", description: "exec base" },
      ...(hasProcessTool ? [{ name: "process", description: "process base" }] : []),
      ...(schedulerToolName ? [{ name: schedulerToolName, description: "scheduler base" }] : []),
    ] as AnyAgentTool[]),
  );
  const tool = tools.find((entry) => entry.name === toolName);
  return {
    toolNames: tools.map((entry) => entry.name),
    description: tool?.description ?? "",
  };
}

describe("createOpenClawCodingTools availability guidance", () => {
  it.each([
    { available: [], mode: "suggest", deferred: false },
    { available: ["sessions_yield", "agents_wait"], mode: "prefer", deferred: true },
  ] as const)(
    "separates collector waits from announcing yields: $available $mode deferred=$deferred",
    ({ available, mode, deferred }) => {
      const availableNames = new Set<string>(available);
      const toolOptions = {
        config: {
          agents: { entries: { main: { default: true } } },
          tools: { swarm: true },
        },
        agentSessionKey: "agent:main:main",
      };
      const spawn = createSessionsSpawnTool(toolOptions);
      const tools = applyToolAvailabilityDescriptions([
        spawn,
        ...available.map((name) =>
          name === "sessions_yield"
            ? createSessionsYieldTool()
            : createAgentsWaitTool({ ...toolOptions, agentId: "main" }),
        ),
      ]);
      const toolNames = tools.map((tool) => tool.name);
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        subagentDelegationMode: mode,
        toolNames: deferred ? ["tool_search"] : toolNames,
        capabilityToolNames: deferred ? toolNames : [],
      });
      const guidance = [prompt, ...tools.map((tool) => tool.description)].join("\n");
      expect.soft(guidance).not.toContain("completion push-based.");
      expect.soft(guidance).not.toContain("Need results before reply: `sessions_yield`");
      expect
        .soft(guidance)
        .not.toContain("End turn after subagent spawn; results arrive next message");
      for (const name of ["agents_wait", "sessions_yield"] as const) {
        expect(guidance.includes(name)).toBe(availableNames.has(name));
      }
      if (availableNames.has("agents_wait")) {
        expect.soft(guidance).toMatch(/collector[^.\n]*no completion notification/i);
        expect(guidance).toMatch(/await with agents_wait/);
        for (const field of ["collect", "outputSchema", "groupId"]) {
          expect(spawn.parameters).toHaveProperty(`properties.${field}`);
        }
      } else {
        for (const field of ["collect", "outputSchema", "groupId"]) {
          expect(spawn.parameters).not.toHaveProperty(`properties.${field}`);
        }
        expect(guidance).not.toContain("collect=true");
      }
    },
  );

  it("uses canonical automation guidance for the retained cron alias", () => {
    const schedulerToolName = "cron";
    const exec = findToolDescription("exec", schedulerToolName);
    const process = findToolDescription("process", schedulerToolName);

    expect(exec.toolNames).toEqual(["exec", "process", schedulerToolName]);
    expect(exec.description).toBe(
      "Run shell now; background continuation supported. Completed calls return command output directly. Use process only when exec reports running with a sessionId; output text alone is not a process handle. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. No sleep loops for reminders/follow-ups; use automations. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
    );
    expect(process.description).toBe(
      "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention. No polling as timer/reminder; scheduled follow-up uses automations.",
    );
  });

  it("drops automation guidance when the scheduler is unavailable", () => {
    const exec = findToolDescription("exec");
    const process = findToolDescription("process");

    expect(exec.toolNames).toEqual(["exec", "process"]);
    expect(exec.description).toBe(
      "Run shell now; background continuation supported. Completed calls return command output directly. Use process only when exec reports running with a sessionId; output text alone is not a process handle. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
    );
    expect(process.description).toBe(
      "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention.",
    );
  });

  it("keeps shell-quoting guidance without background continuation", () => {
    const exec = findToolDescription("exec", undefined, false);

    expect(exec.description).toBe(
      "Run shell and wait for completion. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
    );
  });

  it("preserves plugin and channel ownership when replacing descriptions", () => {
    const originalTool = {
      name: "process",
      description: "plugin process",
    } as AnyAgentTool;
    setPluginToolMeta(originalTool, { pluginId: "example", optional: false });
    setChannelAgentToolMeta(originalTool as never, { channelId: "example-channel" });

    const [updated] = applyToolAvailabilityDescriptions([originalTool]);

    expect(updated).not.toBe(originalTool);
    expect(getPluginToolMeta(expectDefined(updated, "updated test invariant"))).toEqual({
      pluginId: "example",
      optional: false,
    });
    expect(getChannelAgentToolMeta(updated as never)).toEqual({
      channelId: "example-channel",
    });
  });

  it("mentions sessions_spawn only when it survives tool filtering", () => {
    const withoutSpawn = applyToolAvailabilityDescriptions([
      { name: "agents_list", description: "base" },
      { name: "agents_wait", description: "base" },
    ] as AnyAgentTool[]);
    const withSpawn = applyToolAvailabilityDescriptions([
      ...withoutSpawn,
      { name: "sessions_spawn", description: "spawn" },
    ] as AnyAgentTool[]);

    for (const tool of withoutSpawn) {
      expect(tool.description).not.toContain("sessions_spawn");
    }
    for (const tool of withSpawn.filter((entry) => entry.name !== "sessions_spawn")) {
      expect(tool.description).toContain("sessions_spawn");
    }
  });

  it.each([
    { available: [], expected: [] },
    {
      available: ["conversations_list", "conversations_send"],
      expected: ["conversations_list", "conversations_send"],
    },
    {
      available: ["conversations_list", "conversations_turn"],
      expected: ["conversations_list", "conversations_turn"],
    },
  ])("describes only executable conversation routes: $available", ({ available, expected }) => {
    const [tool] = applyToolAvailabilityDescriptions([
      { name: "sessions_send", description: describeSessionsSendTool() },
      ...available.map((name) => ({ name, description: "available" })),
    ] as AnyAgentTool[]);

    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(tool?.description.includes(name)).toBe(expected.includes(name));
    }
  });

  it("keeps authorized history guidance and the prepared session URL", () => {
    const sessionLinkBase = "https://gateway.example/control";
    const [tool] = applyToolAvailabilityDescriptions([
      {
        name: "sessions_search",
        description: describeSessionsSearchTool({ sessionLinkBase }),
      },
      { name: "sessions_history", description: "history" },
    ] as AnyAgentTool[]);

    expect(tool?.description).toContain("Search visible past sessions");
    expect(tool?.description).toContain("sessions_history");
    expect(tool?.description).toContain(`${sessionLinkBase}/chat/<agentId>`);
    expect(tool?.description.indexOf("Follow up with sessions_history")).toBeLessThan(
      tool?.description.indexOf("When pointing the user at a session") ?? Infinity,
    );
  });

  it("restores conversation lookup guidance only when lookup is authorized", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      createConversationsSendTool(),
      { name: "conversations_list", description: "lookup" } as AnyAgentTool,
    ]);

    expect(tool?.description).toBe(
      "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
    );
  });

  it("keeps only authorized spawn follow-ups without losing prepared runtime facts", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      {
        name: "sessions_spawn",
        description: describeSessionsSpawnTool({
          acpAvailable: false,
          threadAvailable: true,
          sessionToolsVisibility: "self",
          swarmEnabled: true,
        }),
      },
      { name: "agents_list", description: "agent lookup" },
      { name: "sessions_history", description: "history" },
    ] as AnyAgentTool[]);

    expect(tool?.description).toContain("configured agent (see agents_list);");
    expect(tool?.description).toContain("sessions_history");
    expect(tool?.description).not.toContain("agents_wait");
    expect(tool?.description).not.toContain("`subagents`");
    expect(tool?.description).toContain("persistent/thread-bound");
    expect(tool?.description).toContain("(self: current session only)");
    expect(tool?.description).not.toContain('runtime="acp"');
    // Transcript access alone does not expose execution/delivery diagnostics.
    expect(tool?.description).not.toContain("When diagnosing a missing result");
  });

  it("preserves original inline spawn guidance when every follow-up remains available", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      createSessionsSpawnTool({ config: { tools: { swarm: true } } }),
      createAgentsWaitTool({}),
      ...["agents_list", "subagents", "sessions_history"].map((name) => ({
        name,
        description: "available",
      })),
    ] as AnyAgentTool[]);

    expect(tool?.description).toContain(
      "Execute work directly by default. Delegate a bounded, independent task only when parallel execution or an independent review provides a concrete benefit. Keep dependent steps with the same owner. Once delegation is appropriate, use a hidden subagent unless the user needs a separate, independently steerable session. This includes substantial, bounded API/service investigations that can be handed off with the needed context and capabilities. For hidden subagents, omit `visible` or set it false, and report results through the parent.",
    );
    expect(tool?.description).not.toContain("trial-and-error");
    expect(tool?.description).toContain("configured agent (see agents_list);");
    expect(tool?.description).toContain("`groupId` groups a batch; await with agents_wait.");
    expect(tool?.description).toContain("(all: all sessions, cross-agent per tools.agentToAgent)");
    expect(tool?.description).toContain(
      "No spawn for quick lookup/single read. Check spawns via `subagents`/`sessions_history`. After spawn,",
    );
    expect(tool?.description).toContain(
      "When diagnosing a missing result from an announcing child, use `subagents` to inspect execution and delivery status. Recover existing results or follow up within the still-authorized task; respect intentional cancellation and never loop-poll.",
    );
  });
});
