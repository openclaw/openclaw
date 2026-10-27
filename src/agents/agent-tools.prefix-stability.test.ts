// Prompt-cache invariant: per-turn facts must not change tool definitions.
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { deriveSessionMetaPatch } from "../config/sessions/metadata.js";
import { patchSessionEntryCore, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveChatSendCallerContext } from "../gateway/server-methods/gateway-client-identity.js";
import { createSessionMutationTestClient } from "../gateway/server-methods/sessions-mutations.owner.test-support.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { inspectOpenDictionaryToolSchemas } from "../plugins/tool-schema-diagnostics.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "./code-mode.js";
import type { PreparedPairedComputerUse } from "./computer-use-node-capabilities.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

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

it("keeps the computer definition across connected desktop capabilities and availability", () => {
  const render = (pairedNodeComputerUse?: PreparedPairedComputerUse) =>
    surface(createOpenClawCodingTools({ ...userTurn, pairedNodeComputerUse }));
  const expected = render();
  for (const actions of [["screenshot"], ["list_windows", "screenshot"]] as const) {
    const computerUse = {
      contractVersion: 2 as const,
      provider: { id: "fixture", label: "Fixture", generation: "generation-2" },
      actions: [...actions],
      targets: ["screen"] as const,
      deliveryModes: ["foreground"] as const,
      observations: ["image"] as const,
      features: { recording: false, agentCursor: false, multiDisplay: true },
    };
    for (const available of [false, true]) {
      expect(
        render({
          actions,
          guidanceCapabilities: computerUse,
          gateway: { configured: true, available, computerUse },
        }),
      ).toEqual(expected);
    }
  }
  expect(render({ actions: [], gateway: { configured: false, available: false } })).toEqual(
    expected,
  );
});

it("keeps an unavailable session desktop listed while gating its execution", async () => {
  const create = (computerTransport: ToolOptions["computerTransport"]) =>
    createOpenClawCodingTools({ ...userTurn, computerTransport });
  const unavailable = create(null);
  const desktop = unavailable.find((tool) => tool.name === "computer");
  expect(desktop).toBeDefined();
  expect((await desktop!.execute("unavailable", { action: "screenshot" })).details).toMatchObject({
    gated: true,
  });
  expect(surface(unavailable)).toEqual(
    surface(
      create({
        resolveNode: async () => ({ nodeId: "session-desktop" }),
        invoke: async () => undefined,
      }),
    ),
  );
});

async function webchatSession(clientKind: "browser" | "cli" = "browser") {
  const sessionKey = "agent:main:dashboard:prefix-proof";
  const store = path.join(sessionDirs.make(), "sessions.json");
  const sessionConfig: OpenClawConfig = { ...config, session: { store } };
  setRuntimeConfigSnapshot(sessionConfig);
  const scope = { agentId: "main", sessionKey, storePath: store };
  await replaceSessionEntry(scope, {
    sessionId: "webchat-session",
    updatedAt: 1,
  });
  const update = (ctx: Parameters<typeof deriveSessionMetaPatch>[0]["ctx"]) =>
    patchSessionEntryCore(scope, (existing) =>
      deriveSessionMetaPatch({ ctx, existing, sessionKey }),
    );
  const client = createSessionMutationTestClient();
  if (clientKind === "cli") {
    client.connect.client = { ...client.connect.client, id: "cli", mode: "cli" };
  } else {
    client.connect.caps = ["ui-commands", "inline-widgets"];
  }
  const callerContext = resolveChatSendCallerContext(client, undefined, "webchat");
  await update(callerContext);
  const operator: ToolOptions = {
    ...userTurn,
    config: sessionConfig,
    sessionKey,
    messageProvider: "webchat",
    messageChannel: "webchat",
    messageTo: undefined,
    clientCaps: client.connect.caps,
  };
  const wake: ToolOptions = {
    ...operator,
    clientCaps: undefined,
    senderId: undefined,
    senderIsOwner: false,
    inputProvenance: {
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    },
  };
  return { sessionKey, operator, wake, update, callerContext };
}

it.each(["browser", "cli"] as const)(
  "keeps the %s WebChat catalog across wakes and recovery",
  async (clientKind) => {
    const { sessionKey, operator, wake, update, callerContext } = await webchatSession(clientKind);
    const render = (options: ToolOptions) => {
      const tools = createOpenClawCodingTools(options);
      const catalogRef = createToolSearchCatalogRef();
      const ctx = { config: options.config, catalogRef };
      onTestFinished(() => clearToolSearchCatalog(ctx));
      const compacted = applyCodeModeCatalog({
        ...ctx,
        tools: [...createCodeModeTools(ctx), ...tools],
      });
      return {
        names: tools.map((tool) => tool.name),
        definitions: surface(tools),
        compacted: surface(compacted.tools),
        prompt: buildCodeModeCatalogPrompt(ctx, catalogRef.current?.entries ?? []),
      };
    };
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "prefix-operator",
      scopes: ["operator.write"],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    const expected = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey, operatorAuthority },
      () => render(operator),
    );
    expect(expected.names).toContain("sessions_create");
    expect(createOpenClawCodingTools(operator).some((tool) => tool.name === "screen")).toBe(
      clientKind === "browser",
    );
    await update({
      Provider: "webchat",
      GatewayClientCaps: [],
      InputProvenance: wake.inputProvenance,
    });
    const wakeSurface = render(wake);
    expect(wakeSurface.names).toEqual(expected.names);
    expect(wakeSurface).toEqual(expected);
    const refused = await createOpenClawCodingTools(wake)
      .find((tool) => tool.name === "sessions_create")!
      .execute("wake-create", {});
    expect(refused.details).toMatchObject({ gated: true });
    expect(JSON.stringify(refused.content)).toContain("session write authority");
    await update({
      ...callerContext,
      GatewayClientCaps: [],
      InputProvenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
    });
    expect(render({ ...wake, inputProvenance: undefined, trigger: "event" })).toEqual(expected);

    // A new operator declaration replaces the old client's capabilities.
    await update({ ...callerContext, GatewayClientCaps: [] });
    expect(createOpenClawCodingTools(operator).map((tool) => tool.name)).not.toContain("screen");
  },
);

it.each([true, false])(
  "keeps GitHub definitions and the catalog across operator and wake turns (publication=%s)",
  async (githubPublicationAvailable) => {
    const render = (options: ToolOptions) => {
      const tools = createOpenClawCodingTools({ ...options, githubPublicationAvailable }).filter(
        (tool) => tool.name.startsWith("github_"),
      );
      expect(tools.some((tool) => tool.name === "github_publish")).toBe(true);
      const catalogRef = createToolSearchCatalogRef();
      const ctx = { config, catalogRef };
      onTestFinished(() => clearToolSearchCatalog(ctx));
      const compacted = applyCodeModeCatalog({
        ...ctx,
        tools: [...createCodeModeTools(ctx), ...tools],
      });
      return {
        definitions: surface(tools),
        compacted: surface(compacted.tools),
        prompt: buildCodeModeCatalogPrompt(ctx, catalogRef.current?.entries ?? []),
      };
    };
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "prefix-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    const expected = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: session.sessionKey!, operatorAuthority },
      () => render(userTurn),
    );
    for (const sourceTool of ["subagent_announce", "subagent_settle"]) {
      expect(render(completionTurn(sourceTool))).toEqual(expected);
    }
    expect(render({ ...session, trigger: "cron", jobId: "scheduled-continuation" })).toEqual(
      expected,
    );
    expect(render({ ...session, trigger: "heartbeat" })).toEqual(expected);
  },
);

it("refuses a wake-turn screen call without a requesting UI through the execution gate", async () => {
  const { wake } = await webchatSession();
  for (const senderIsOwner of [false, true]) {
    const screen = createOpenClawCodingTools({ ...wake, senderIsOwner }).find(
      (tool) => tool.name === "screen",
    );
    expect(screen).toBeDefined();
    const result = await screen!.execute("wake-screen", { action: "sidebar_show" });
    expect(result.details).toMatchObject({ gated: true });
    expect(JSON.stringify(result.content)).toContain("open Control UI");
    expect(JSON.stringify(result.content)).toContain(
      senderIsOwner ? "requires a connected requesting client" : "needs the owner's authority",
    );
  }
});

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
    "write is not available during a child-completion turn",
  );
});
