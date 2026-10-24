// Prompt-cache invariant: per-turn facts must not change tool definitions.
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { inspectOpenDictionaryToolSchemas } from "../plugins/tool-schema-diagnostics.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-plugin-tools.js")>()),
  resolveOpenClawPluginToolsForOptions: () => [],
}));

type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { codeMode: false, toolSearch: false },
};

const session: ToolOptions = {
  config,
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:owner",
  workspaceDir: "/tmp/openclaw-prefix-stability",
  messageProvider: "telegram",
  messageTo: "telegram:owner",
  trigger: "user",
  senderIsOwner: false,
  sourceReplyDeliveryMode: "automatic",
};

function completionTurn(sourceTool: string): ToolOptions {
  return {
    ...session,
    runId: `run-${sourceTool}`,
    inputProvenance: { kind: "inter_session", sourceChannel: "internal", sourceTool },
  };
}
const userTurn = { ...session, runId: "run-user", senderId: "owner", senderIsOwner: true };

function surface(tools: ReturnType<typeof createOpenClawCodingTools>) {
  return tools.map((tool) =>
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  );
}

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(createSessionConversationTestRegistry());
});
afterEach(() => clearRuntimeConfigSnapshot());

it("produces no raw dictionary findings for the default core tools", () => {
  const tools = createOpenClawCodingTools({
    config: {},
    modelProvider: "openai",
    modelId: "gpt-5.4",
  });
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["exec", "dashboard", "automations", "sessions_spawn"]),
  );
  expect(inspectOpenDictionaryToolSchemas(tools)).toEqual([]);
});

it.each<[string, ToolOptions]>([
  [
    "subagent completion",
    { ...completionTurn("subagent_announce"), sourceReplyDeliveryMode: "message_tool_only" },
  ],
  ["media completion", completionTurn("image_generate")],
  [
    "scheduled",
    {
      ...session,
      runId: "run-scheduled",
      trigger: "cron",
      sourceReplyDeliveryMode: "message_tool_only",
    },
  ],
])("offers the user turn's exact tool definitions on a %s turn", (_kind, options) => {
  expect(surface(createOpenClawCodingTools(options))).toEqual(
    surface(createOpenClawCodingTools(userTurn)),
  );
});
it("offers the same message definition on a source-bound completion turn", () => {
  const assemble = (sourceReplyOnly: boolean) =>
    surface(
      createOpenClawTools({
        config,
        agentSessionKey: session.sessionKey,
        agentChannel: "telegram",
        agentTo: "telegram:owner",
        sourceReplyOnly,
      }),
    );

  expect(assemble(true)).toEqual(assemble(false));
});

it.each(["agent:main:operator-task", "agent:main:telegram:direct:owner"])(
  "keeps message definitions stable across CLI, recovery, and announce sources in %s",
  (sessionKey) => {
    const messageDefinition = (options: ToolOptions) => {
      const tool = createOpenClawCodingTools({ ...session, ...options, sessionKey }).find(
        (entry) => entry.name === "message",
      )!;
      return JSON.stringify({ description: tool.description, parameters: tool.parameters });
    };
    const cli = messageDefinition({ messageProvider: undefined, messageTo: undefined });
    for (const sourceTool of [undefined, "subagent_announce", "subagent_settle"]) {
      expect(
        messageDefinition({
          messageProvider: "webchat",
          messageTo: "recovery-source",
          currentMessageId: "recovery-message",
          senderId: "recovery-sender",
          senderIsOwner: true,
          sourceReplyDeliveryMode: "message_tool_only",
          ...(sourceTool && {
            inputProvenance: { kind: "inter_session", sourceChannel: "internal", sourceTool },
          }),
        }),
      ).toBe(cli);
    }
  },
);

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-prefix-handoff-");
it("offers the session's tool definitions and refuses tools outside the replayed authority", async () => {
  const store = path.join(sessionDirs.make(), "{agentId}", "sessions.json");
  const handoffConfig: OpenClawConfig = { ...config, session: { store } };
  setRuntimeConfigSnapshot(handoffConfig);
  const requesterSessionKey = session.sessionKey!;
  const childSessionKey = "agent:main:subagent:child";
  await replaceSessionEntry(
    {
      agentId: "main",
      sessionKey: childSessionKey,
      storePath: store.replaceAll("{agentId}", "main"),
    },
    {
      sessionId: "child-session",
      updatedAt: Date.now(),
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "message", "sessions_spawn"],
    },
  );
  const request = {
    ...session,
    config: handoffConfig,
    sessionId: "requester-session",
    modelProvider: "openai",
    modelId: "gpt-5.4",
    inputProvenance: {
      kind: "inter_session" as const,
      sourceSessionKey: childSessionKey,
      sourceTool: "subagent_announce",
    },
    trustedInternalHandoff: {
      kind: "subagent-completion" as const,
      sourceSessionKey: childSessionKey,
      sourceSessionId: "child-session",
      targetSessionKey: requesterSessionKey,
      targetSessionId: "requester-session",
      provider: "openai",
      model: "gpt-5.4",
    },
  };
  const conversationCapabilityProfile = await prepareConversationCapabilityProfile(request);
  expect(conversationCapabilityProfile.policy.requesterPolicySource).toBe("completion-handoff");
  const completion = createOpenClawCodingTools({
    ...request,
    runId: "run-handoff",
    senderIsOwner: false,
    sourceReplyDeliveryMode: "message_tool_only",
    conversationCapabilityProfile,
  });
  const user = createOpenClawCodingTools({
    ...userTurn,
    config: handoffConfig,
    sessionId: "requester-session",
  });
  expect(surface(completion)).toEqual(surface(user));
  const refused = await completion.find((tool) => tool.name === "write")!.execute("write", {});
  expect(refused.details).toMatchObject({ gated: true });
  expect(JSON.stringify(refused.content)).toContain(
    "write is outside the authority this completion turn carries",
  );
});
