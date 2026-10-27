import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { expectText as expectGuidance } from "../test-utils/text-assertions.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  describeSessionsSearchTool,
  describeSessionsSendTool,
  describeSessionsSpawnTool,
} from "./tool-description-presets.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { createHostedConversationTools } from "./tools/conversation-tools.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

function tool(name: string, description = "available"): AnyAgentTool {
  return { ...createStubTool(name), description };
}
function describeFirst(source: AnyAgentTool, siblings: string[] = []) {
  return expectDefined(
    applyToolAvailabilityDescriptions([source, ...siblings.map((name) => tool(name))])[0],
    "described tool",
  );
}

it.each([
  ["yield", createSessionsYieldTool, "sessions_send", "use sessions_send"],
  ["collector yield", createSessionsYieldTool, "agents_wait", "require agents_wait"],
  ["agent list", () => tool("agents_list"), "sessions_spawn", "sessions_spawn"],
  ["collector", () => tool("agents_wait"), "sessions_spawn", "sessions_spawn"],
] as const)(
  "gates %s follow-up guidance on its executable sibling",
  (_label, create, sibling, guidance) => {
    expect(describeFirst(create()).description).not.toContain(guidance);
    expect(describeFirst(create(), [sibling]).description).toContain(guidance);
  },
);

it.each([false, true])(
  "names only executable conversation routes (thread targets: %s)",
  (allowThreadTargets) => {
    const source = tool("sessions_send", describeSessionsSendTool({ allowThreadTargets }));
    expectGuidance(
      describeFirst(source, ["conversations_list", "conversations_send"]).description,
      ["conversations_list", "conversations_send"],
      ["conversations_turn"],
    );
  },
);

it.each([false, true])("adds canonical scheduler guidance only when available: %s", (available) => {
  const names = ["exec", "process", ...(available ? ["cron"] : [])];
  const tools = withMockedPlatform("linux", () =>
    applyToolAvailabilityDescriptions(names.map((name) => tool(name))),
  );
  const [exec, process] = tools.map((entry) => entry.description);
  expect(exec?.includes("use automations")).toBe(available);
  expect(process?.includes("scheduled follow-up uses automations")).toBe(available);
});

it("preserves plugin and channel metadata when replacing a description", () => {
  const original = tool("process", "plugin process");
  setPluginToolMeta(original, { pluginId: "example", optional: false });
  setChannelAgentToolMeta(original as never, { channelId: "example-channel" });
  const updated = describeFirst(original);
  expect(updated).not.toBe(original);
  expect(getPluginToolMeta(updated)).toEqual({ pluginId: "example", optional: false });
  expect(getChannelAgentToolMeta(updated as never)).toEqual({ channelId: "example-channel" });
});

it("inserts history guidance before the preserved session URL", () => {
  const base = "https://gateway.example/control";
  const text = describeFirst(
    tool("sessions_search", describeSessionsSearchTool({ sessionLinkBase: base })),
    ["sessions_history"],
  ).description;
  expectGuidance(text, [
    "Search visible past sessions",
    "sessions_history",
    base + "/chat/<agentId>",
  ]);
  expect(text.indexOf("Follow up with sessions_history")).toBeLessThan(
    text.indexOf("When pointing the user at a session"),
  );
});

it("names authorized conversation lookup", () => {
  const send = expectDefined(
    createHostedConversationTools(undefined, "main", {}).find(
      (t) => t.name === "conversations_send",
    ),
    "conversation send tool",
  );
  expect(describeFirst(send, ["conversations_list"]).description).toBe(
    "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
  );
});

it.each([false, true])(
  "gates spawn follow-ups while preserving configured visibility: %s",
  (full) => {
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
    const siblings = [
      tool("agents_list"),
      tool("sessions_history"),
      ...(full ? [createAgentsWaitTool({}), tool("subagents")] : []),
    ];
    const text = expectDefined(
      applyToolAvailabilityDescriptions([source, ...siblings])[0],
      "spawn",
    ).description;
    expectGuidance(text, ["configured agent (see agents_list);", "sessions_history"]);
    if (full) {
      expectGuidance(text, [
        "Collectors send no completion notification",
        "`groupId` groups a batch; await with agents_wait.",
        "(all: all sessions, cross-agent per tools.agentToAgent)",
        "Check spawns via `subagents`/`sessions_history`.",
        "use `subagents` to inspect execution and delivery status",
        "respect intentional cancellation and never loop-poll.",
      ]);
    } else {
      expectGuidance(
        text,
        ["persistent/thread-bound", "(self: current session only)"],
        ["agents_wait", "`subagents`", 'runtime="acp"', "When diagnosing a missing result"],
      );
    }
  },
);

it("adds node file-listing guidance without changing the argument description", () => {
  const nodes = createNodesTool();
  const without = describeFirst(nodes);
  expectGuidance(
    without.description,
    ["fs.listDir returns sub-directories only"],
    ["use the exec tool with host=node"],
  );
  expect(describeFirst(nodes, ["exec"]).description).toContain(
    "fs.listDir returns sub-directories only; use the exec tool with host=node to list files",
  );
  const invoke = (without.parameters as { properties?: Record<string, { description?: string }> })
    .properties?.invokeCommand;
  expectGuidance(
    expectDefined(invoke?.description, "invokeCommand description"),
    ["fs.listDir returns sub-directories only"],
    ["use the exec tool"],
  );
});
