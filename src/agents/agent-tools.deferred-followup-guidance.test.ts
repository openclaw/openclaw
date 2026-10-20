/** Tests model-facing descriptions selected from the final authorized tool set. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  describeSessionsSearchTool,
  describeSessionsSendTool,
  describeSessionsSpawnTool,
} from "./tool-description-presets.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { createConversationsSendTool } from "./tools/conversation-tools.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

function tool(name: string, description = "available"): AnyAgentTool {
  return { ...createStubTool(name), description };
}

function describeTools(...tools: (AnyAgentTool | string)[]) {
  return applyToolAvailabilityDescriptions(
    tools.map((entry) => (typeof entry === "string" ? tool(entry) : entry)),
  );
}

function describeFirst(source: AnyAgentTool, ...siblings: (AnyAgentTool | string)[]) {
  return expectDefined(describeTools(source, ...siblings)[0], "described tool").description;
}

function expectGuidance(text: string, included: string[], excluded: string[] = []) {
  for (const fragment of included) {
    expect(text).toContain(fragment);
  }
  for (const fragment of excluded) {
    expect(text).not.toContain(fragment);
  }
}

describe("createOpenClawCodingTools availability guidance", () => {
  it.each([false, true])("gates sessions_send guidance (%s)", (hasSessionsSend) => {
    const text = describeFirst(
      createSessionsYieldTool(),
      ...(hasSessionsSend ? ["sessions_send"] : []),
    );
    expect(text).toContain("Does not message other sessions");
    expect(text.includes("use sessions_send")).toBe(hasSessionsSend);
  });

  it.each([
    { available: [], mode: "suggest", deferred: false },
    { available: ["sessions_yield", "agents_wait"], mode: "prefer", deferred: true },
  ] as const)(
    "separates collector wait and yield ($mode, deferred=$deferred)",
    ({ available, mode, deferred }) => {
      const availableNames = new Set<string>(available);
      const toolOptions = {
        config: {
          agents: { entries: { main: {} } },
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
      const toolNames = tools.map((entry) => entry.name);
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        subagentDelegationMode: mode,
        toolNames: deferred ? ["tool_search"] : toolNames,
        capabilityToolNames: deferred ? toolNames : [],
      });
      const guidance = [prompt, ...tools.map((entry) => entry.description)].join("\n");
      expect.soft(guidance).not.toContain("completion push-based.");
      expect.soft(guidance).not.toContain("Need results before reply: `sessions_yield`");
      expect
        .soft(guidance)
        .not.toContain("End turn after subagent spawn; results arrive next message");
      for (const name of ["agents_wait", "sessions_yield"] as const) {
        expect(guidance.includes(name)).toBe(availableNames.has(name));
      }
      for (const field of ["collect", "outputSchema", "groupId"]) {
        const assertion = availableNames.has("agents_wait")
          ? expect(spawn.parameters)
          : expect(spawn.parameters).not;
        assertion.toHaveProperty(`properties.${field}`);
      }
      if (availableNames.has("agents_wait")) {
        expect.soft(guidance).toMatch(/collector[^.\n]*no completion notification/i);
        expect(guidance).toMatch(/await with agents_wait/);
      } else {
        expect(guidance).not.toContain("collect=true");
      }
    },
  );

  it("uses canonical guidance for the cron alias", () => {
    const tools = withMockedPlatform("linux", () => describeTools("exec", "process", "cron"));
    const [exec, process] = tools;

    expect(tools.map((entry) => entry.name)).toEqual(["exec", "process", "cron"]);
    expectGuidance(expectDefined(exec, "exec tool").description, [
      "background continuation supported",
      "use automations",
    ]);
    expectGuidance(expectDefined(process, "process tool").description, [
      "Control existing exec",
      "scheduled follow-up uses automations",
    ]);
  });

  it("preserves plugin and channel metadata", () => {
    const originalTool = tool("process", "plugin process");
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

  it("gates sessions_spawn guidance", () => {
    const withoutSpawn = describeTools("agents_list", "agents_wait");
    const withSpawn = describeTools(...withoutSpawn, "sessions_spawn");

    for (const entry of withoutSpawn) {
      expect(entry.description).not.toContain("sessions_spawn");
    }
    for (const entry of withSpawn.filter((candidate) => candidate.name !== "sessions_spawn")) {
      expect(entry.description).toContain("sessions_spawn");
    }
  });

  it.each([false, true])("names only executable conversation routes (%s)", (allowThreadTargets) => {
    const text = describeFirst(
      tool("sessions_send", describeSessionsSendTool({ allowThreadTargets })),
      "conversations_list",
      "conversations_send",
    );

    expectGuidance(text, ["conversations_list", "conversations_send"], ["conversations_turn"]);
  });

  it("keeps history guidance and session URL", () => {
    const sessionLinkBase = "https://gateway.example/control";
    const text = describeFirst(
      tool("sessions_search", describeSessionsSearchTool({ sessionLinkBase })),
      "sessions_history",
    );

    expect(text).toContain("Search visible past sessions");
    expect(text).toContain("sessions_history");
    expect(text).toContain(`${sessionLinkBase}/chat/<agentId>`);
    expect(text.indexOf("Follow up with sessions_history")).toBeLessThan(
      text.indexOf("When pointing the user at a session"),
    );
  });

  it("names authorized conversation lookup", () => {
    expect(describeFirst(createConversationsSendTool(), "conversations_list")).toBe(
      "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
    );
  });

  it.each([false, true])("preserves spawn facts with full follow-ups=%s", (full) => {
    const source = full
      ? createSessionsSpawnTool({ config: { tools: { swarm: true } } })
      : tool(
          "sessions_spawn",
          describeSessionsSpawnTool({
            acpAvailable: false,
            threadAvailable: true,
            sessionToolsVisibility: "self",
            swarmEnabled: true,
          }),
        );
    const text = describeFirst(
      source,
      "agents_list",
      "sessions_history",
      ...(full ? [createAgentsWaitTool({}), "subagents"] : []),
    );
    expect(text).toContain("configured agent (see agents_list);");
    if (!full) {
      expectGuidance(
        text,
        ["sessions_history", "persistent/thread-bound", "(self: current session only)"],
        ["agents_wait", "`subagents`", 'runtime="acp"', "When diagnosing a missing result"],
      );
      return;
    }
    expectGuidance(
      text,
      [
        "Execute work directly by default. Delegate a bounded, independent task only when parallel execution or an independent review provides a concrete benefit. Keep dependent steps with the same owner. Once delegation is appropriate, use a hidden subagent unless the user needs to revisit or steer deliberately supervised child work. This includes substantial, bounded API/service investigations that can be handed off with the needed context and capabilities. For hidden subagents, omit `visible` or set it false, and report results through the parent.",
        "`groupId` groups a batch; await with agents_wait.",
        "(all: all sessions, cross-agent per tools.agentToAgent)",
        "No spawn for quick lookup/single read. Check spawns via `subagents`/`sessions_history`. After spawn,",
        "When diagnosing a missing result from an announcing child, use `subagents` to inspect execution and delivery status. Recover existing results or follow up within the still-authorized task; respect intentional cancellation and never loop-poll.",
      ],
      ["trial-and-error"],
    );
  });

  it("gates exec file-listing guidance", () => {
    const nodes = createNodesTool();
    const [withoutExec] = describeTools(nodes);
    const [withExec] = describeTools(nodes, "exec");

    expect(withoutExec?.description).toContain("fs.listDir returns sub-directories only");
    expect(withoutExec?.description).not.toContain("use the exec tool with host=node");
    expect(withExec?.description).toContain(
      "fs.listDir returns sub-directories only; use the exec tool with host=node to list files",
    );
    const invokeCommand = (
      expectDefined(withoutExec, "nodes tool").parameters as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties?.invokeCommand;
    expect(invokeCommand?.description).toContain("fs.listDir returns sub-directories only");
    expect(invokeCommand?.description).not.toContain("use the exec tool");
  });
});
