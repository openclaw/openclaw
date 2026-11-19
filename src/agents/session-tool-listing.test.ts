// Prompt-cache invariant: one session sends one tool list, whatever starts each turn.
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { COMPUTER_USE_V2_ACTION_NAMES } from "../plugins/computer-use-schemas.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { isAgentToolExecutionAvailable } from "./agent-tool-availability.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  clearEmbeddedSessionPromptStates,
  prepareSessionToolSurface,
  retainEmbeddedSessionPromptState,
} from "./embedded-agent-runner/session-prompt-state.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { applyAgentToolSurfaceCatalog } from "./tool-surface-plan.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("./openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));

type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

// The coding profile omits `message` unless a turn's reply delivery adds it.
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: {
    profile: "coding",
    alsoAllow: ["computer"],
    codeMode: false,
    toolSearch: { enabled: true, mode: "tools" },
  },
};
const sessionId = "session-tool-listing";
const session: ToolOptions = {
  config,
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:owner",
  sessionId,
  workspaceDir: "/tmp/openclaw-session-tool-listing",
  messageProvider: "telegram",
  messageTo: "telegram:owner",
  modelProvider: "openai",
  modelId: "gpt-5.4",
  includeToolSearchControls: true,
  senderIsOwner: false,
};
const owner = { senderId: "owner", senderIsOwner: true };
const node = {
  actions: COMPUTER_USE_V2_ACTION_NAMES,
  gateway: { configured: false },
} as unknown as ToolOptions["pairedNodeComputerUse"];
const turns: Record<string, ToolOptions> = {
  // A scheduled run whose delivery may not send.
  cron: {
    ...session,
    runId: "cron",
    trigger: "cron",
    jobId: "listing-job",
    disableMessageTool: true,
    requireExplicitMessageTarget: true,
  },
  user: { ...session, ...owner, runId: "user", trigger: "user" },
  execWake: {
    ...session,
    runId: "exec-wake",
    trigger: "event",
    inputProvenance: { kind: "internal_system", sourceTool: "exec" },
  },
  subagent: {
    ...session,
    runId: "subagent",
    sourceReplyDeliveryMode: "message_tool_only",
    inputProvenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    },
  },
  steer: { ...session, ...owner, runId: "steer", sourceReplyDeliveryMode: "message_tool_only" },
};

function mcpTool(): AnyAgentTool {
  const tool = Object.assign(createStubTool("world__calendar_list"), {
    description: "Calendar events this member organizes or attends.",
  });
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "world",
      safeServerName: "world",
      toolName: "calendar_list",
      operation: "tool",
    },
  });
  return tool as AnyAgentTool;
}

type SessionPromptState = ReturnType<typeof retainEmbeddedSessionPromptState>["state"];

/** The tool list one turn sends to the provider: assembly, Tool Search catalog, session pin. */
function send(
  state: SessionPromptState,
  options: ToolOptions,
  live: { node?: boolean; mcp?: boolean } = {},
) {
  const catalogRef = createToolSearchCatalogRef();
  onTestFinished(() => clearToolSearchCatalog({ catalogRef }));
  const built = createOpenClawCodingTools({
    ...options,
    toolSearchCatalogRef: catalogRef,
    ...(live.node ? { pairedNodeComputerUse: node } : {}),
  });
  const compacted = applyAgentToolSurfaceCatalog({
    tools: live.mcp ? [...built, mcpTool()] : built,
    config,
    catalogRef,
    toolSearchRuntimeConfig: config,
    codeModeControlsEnabled: false,
    toolSearchConfig: resolveToolSearchConfig(config),
  });
  return prepareSessionToolSurface({
    state,
    routeKey: "listing-route",
    toolPolicy: "listing-policy",
    entries: [],
    historyBoundaryCount: 0,
    tools: compacted.tools,
  });
}

function definitions(tools: AnyAgentTool[]) {
  return tools.map((tool) =>
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  );
}

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          actions: { describeMessageTool: () => ({ actions: ["send"] }) },
        },
      },
    ]),
  );
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearEmbeddedSessionPromptStates([sessionId]);
});

it("sends one tool list across user, cron, exec-wake, subagent and steer turns", () => {
  // One retained session state across the turns, like an active chat.
  using chat = retainEmbeddedSessionPromptState(sessionId);
  const sent = [
    send(chat.state, turns.cron!),
    send(chat.state, turns.user!, { node: true, mcp: true }),
    send(chat.state, turns.execWake!),
    send(chat.state, turns.subagent!, { mcp: true }),
    send(chat.state, turns.steer!, { node: true }),
    send(chat.state, turns.user!),
    send(chat.state, turns.cron!, { node: true, mcp: true }),
  ].map(definitions);
  expect(sent).toEqual(sent.map(() => sent[0]));
});

it("lets a later user turn send with message in a series a cron turn started", async () => {
  using chat = retainEmbeddedSessionPromptState(sessionId);
  const cron = send(chat.state, turns.cron!);
  const steer = send(chat.state, turns.steer!);
  expect(definitions(steer)).toEqual(definitions(cron));
  const cronMessage = cron.find((tool) => tool.name === "message");
  const steerMessage = steer.find((tool) => tool.name === "message");
  expect(steerMessage && isAgentToolExecutionAvailable(steerMessage)).toBe(true);
  // A cron run that may not deliver lists message and refuses the call visibly.
  expect(cronMessage && isAgentToolExecutionAvailable(cronMessage)).toBe(false);
  const refused = await cronMessage!.execute("cron-send", { action: "send", message: "hi" });
  expect(refused.details).toMatchObject({ gated: true });
  expect(JSON.stringify(refused.content)).toContain("message cannot send on this turn");
});
