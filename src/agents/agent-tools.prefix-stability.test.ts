// Prompt-cache invariant: within one session, every turn kind offers the same tool surface.
// Provider prefix caches key on the tool definitions first, so a per-turn difference in a
// tool's name, description or schema misses the cache for the whole request.
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
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

// Facts shared by every turn of one owner DM session.
const session: ToolOptions = {
  config,
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:owner",
  workspaceDir: "/tmp/openclaw-prefix-stability",
  messageProvider: "telegram",
  messageTo: "telegram:owner",
};

// Per-turn facts, as each caller sets them today.
const turns: Record<string, ToolOptions> = {
  user: {
    ...session,
    runId: "run-user",
    trigger: "user",
    senderId: "owner",
    senderIsOwner: true,
    sourceReplyDeliveryMode: "automatic",
  },
  subagentCompletion: {
    ...session,
    runId: "run-subagent-completion",
    trigger: "user",
    senderIsOwner: false,
    inputProvenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    },
    sourceReplyDeliveryMode: "message_tool_only",
  },
  mediaCompletion: {
    ...session,
    runId: "run-media-completion",
    trigger: "user",
    senderIsOwner: false,
    inputProvenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "image_generate",
    },
    sourceReplyDeliveryMode: "automatic",
  },
  heartbeat: {
    ...session,
    runId: "run-heartbeat",
    trigger: "heartbeat",
    senderIsOwner: false,
    enableHeartbeatTool: true,
    forceHeartbeatTool: true,
    sourceReplyDeliveryMode: "message_tool_only",
  },
};

function toolSurface(options: ToolOptions) {
  return createOpenClawCodingTools(options).map((tool) =>
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
  );
}

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(createSessionConversationTestRegistry());
});
afterEach(() => clearRuntimeConfigSnapshot());

describe("session tool surface", () => {
  const baseline = () => toolSurface(turns.user!);

  it.each(Object.keys(turns).filter((kind) => kind !== "user"))(
    "offers the user turn's exact tool definitions on a %s turn",
    (kind) => {
      const surface = toolSurface(turns[kind]!);
      const expected = baseline();
      const names = (list: string[]) => list.map((entry) => JSON.parse(entry).name as string);
      const changed = names(expected).filter(
        (name) =>
          !surface.includes(expected[names(expected).indexOf(name)]!) &&
          names(surface).includes(name),
      );
      expect({
        missing: names(expected).filter((name) => !names(surface).includes(name)),
        extra: names(surface).filter((name) => !names(expected).includes(name)),
        changed,
      }).toEqual({ missing: [], extra: [], changed: [] });
      expect(surface).toEqual(expected);
    },
  );
});

describe("source-bound completion tool surface", () => {
  // A completion handoff is source-bound; the message tool enforces that per call.
  const assemble = (sourceReplyOnly: boolean) =>
    createOpenClawTools({
      config,
      agentSessionKey: session.sessionKey,
      agentChannel: "telegram",
      agentTo: "telegram:owner",
      sourceReplyOnly,
    }).map((tool) =>
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    );

  it("offers the same message definition on a source-bound completion turn", () => {
    expect(assemble(true)).toEqual(assemble(false));
  });
});

describe("verified subagent completion handoff tool surface", () => {
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
      ...turns.user!,
      config: handoffConfig,
      sessionId: "requester-session",
    });
    const surface = (tools: typeof user) =>
      tools.map((tool) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      );
    expect(surface(completion)).toEqual(surface(user));
    const refused = await completion
      .find((tool) => tool.name === "write")!
      .execute("refused-write", {});
    expect(refused.details).toMatchObject({ gated: true });
    expect(JSON.stringify(refused.content)).toContain(
      "write is outside the authority this completion turn carries",
    );
  });
});
