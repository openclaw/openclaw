import type { IncomingMessage } from "node:http";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { upsertSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type * as MattermostRuntime from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type {
  MattermostRegisteredCommand,
  MattermostSlashCommandPayload,
} from "./slash-commands.js";

type BuildPreparedModelsProviderData =
  typeof import("./runtime-api.js").buildPreparedModelsProviderData;
type SlashDispatchParams = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];

const fixtures = vi.hoisted(() => ({
  payload: {
    token: "valid-token",
    command: "/oc_models",
    text: "models",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
  } satisfies MattermostSlashCommandPayload,
  command: {
    id: "cmd-1",
    token: "valid-token",
    team_id: "team-1",
    trigger: "oc_models",
    method: "P",
    url: "https://gateway.example.com/slash",
    delete_at: 0,
  },
  channel: { id: "chan-1", type: "O", name: "town-square", display_name: "Town Square" },
  catalog: () => ({
    byProvider: new Map<string, Set<string>>(),
    providers: new Array<string>(),
    resolvedDefault: { provider: "openai", model: "gpt-5.5" },
    modelCatalog: [],
    modelNames: new Map<string, string>(),
  }),
}));
const mockState = vi.hoisted(() => ({
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
  parseSlashCommandPayload: vi.fn((): MattermostSlashCommandPayload => ({ ...fixtures.payload })),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
  buildPreparedModelsProviderData: vi.fn<BuildPreparedModelsProviderData>(async () =>
    fixtures.catalog(),
  ),
  resolveMattermostModelPickerEntry: vi.fn((): { kind: string } | null => ({ kind: "summary" })),
  authorizeMattermostCommandInvocation: vi.fn(() => ({
    ok: true,
    commandAuthorized: true,
    channelInfo: { ...fixtures.channel },
    kind: "channel",
    chatType: "channel",
    channelName: "town-square",
    channelDisplay: "Town Square",
    roomLabel: "#town-square",
  })),
  createMattermostClient: vi.fn(() => ({})),
  fetchMattermostChannel: vi.fn(async () => ({ ...fixtures.channel })),
  sendMessageMattermost: vi.fn<typeof import("./send.js").sendMessageMattermost>(
    async (_target, content) => sentMessage(content),
  ),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
  getMattermostCommand: vi.fn(async () => ({ ...fixtures.command })),
  listMattermostCommands: vi.fn(async () => []),
  dispatchInbound: vi.fn(async (_params: SlashDispatchParams) => undefined),
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: mockState.recordDeliveredCommandExchange,
}));

// mock-isolation: Exercise HTTP command delivery without the plugin runtime or request transport.
vi.mock("./runtime-api.js", () => ({
  buildPreparedModelsProviderData: mockState.buildPreparedModelsProviderData,
  isRequestBodyLimitError: vi.fn(() => false),
  logTypingFailure: vi.fn(),
  readRequestBodyWithLimit: mockState.readRequestBodyWithLimit,
  sendHttpRequestRejection: vi.fn(async () => undefined),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostRuntime>()),
  getMattermostRuntime: () => ({
    channel: {
      commands: { shouldHandleTextCommands: () => true },
      text: {
        hasControlCommand: () => false,
        resolveTextChunkLimit: () => 4000,
        resolveMarkdownTableMode: () => "off",
      },
      inbound: { dispatch: mockState.dispatchInbound },
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "agent:agent-1:mattermost:session:1",
          accountId: "default",
        })),
      },
    },
  }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostChannel: mockState.fetchMattermostChannel,
    normalizeMattermostBaseUrl: vi.fn((value: string | undefined) => value?.trim() ?? ""),
    sendMattermostTyping: vi.fn(),
  };
});

vi.mock("./model-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-picker.js")>()),
  resolveMattermostModelPickerCurrentModel: vi.fn(),
  resolveMattermostModelPickerEntry: mockState.resolveMattermostModelPickerEntry,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mockState.authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList: mockState.normalizeMattermostAllowList,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverMattermostReplyPayload: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMattermost: mockState.sendMessageMattermost,
}));

vi.mock("./slash-commands.js", () => ({
  MATTERMOST_SLASH_POST_METHOD: "P",
  getMattermostCommand: mockState.getMattermostCommand,
  listMattermostCommands: mockState.listMattermostCommands,
  normalizeSlashCommandTrigger: (command: string) => command.replace(/^\//, "").trim(),
  parseSlashCommandPayload: mockState.parseSlashCommandPayload,
  resolveCommandText: mockState.resolveCommandText,
}));

let deliverMattermostReplyPayload: typeof import("./reply-delivery.js").deliverMattermostReplyPayload;
let sendMattermostTyping: typeof import("./client.js").sendMattermostTyping;

let createSlashCommandHttpHandler: typeof import("./slash-http.js").createSlashCommandHttpHandler;
let clearMattermostSlashCommandValidationCacheForAccount: typeof import("./slash-http.js").clearMattermostSlashCommandValidationCacheForAccount;

function createRequest(body = "token=valid-token"): IncomingMessage {
  const req = createMockIncomingRequest([body]);
  req.method = "POST";
  req.url = "/slash";
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  return req;
}

function sentMessage(content: string) {
  return {
    messageId: "post-1",
    channelId: "chan-1",
    content,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "post-1" }],
      kind: "text",
    }),
  };
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  streamingMode: "partial",
  config: {},
};

function createHandler(cfg: OpenClawConfig, overrides: Partial<MattermostRegisteredCommand> = {}) {
  return createSlashCommandHttpHandler({
    account: accountFixture,
    cfg,
    runtime: {} as RuntimeEnv,
    registeredCommands: [
      {
        id: "cmd-1",
        teamId: "team-1",
        trigger: "oc_models",
        token: "valid-token",
        url: fixtures.command.url,
        managed: false,
        ...overrides,
      },
    ],
  });
}

async function expectProcessing(handler: ReturnType<typeof createHandler>) {
  const response = createMockServerResponse();
  await handler(createRequest(), response);
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("Processing");
}

function expectSent(text: unknown, options: Record<string, unknown>) {
  expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
    "channel:chan-1",
    text,
    expect.objectContaining(options),
  );
}

function expectRecorded(fields: Record<string, unknown>) {
  expect(mockState.recordDeliveredCommandExchange).toHaveBeenCalledWith(
    expect.objectContaining(fields),
  );
}

describe("slash-http cfg threading", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createSlashCommandHttpHandler, clearMattermostSlashCommandValidationCacheForAccount } =
      await import("./slash-http.js"));
    ({ deliverMattermostReplyPayload } = await import("./reply-delivery.js"));
    ({ sendMattermostTyping } = await import("./client.js"));
  });

  afterEach(() => {
    clearMattermostSlashCommandValidationCacheForAccount(accountFixture.accountId);
  });

  beforeEach(() => Object.values(mockState).forEach((mock) => mock.mockReset()));

  it("passes cfg and catalog status through the no-models slash reply", async () => {
    const refreshWarning = "Some models could not be refreshed.";
    const text = "Some models could not be refreshed.\n\nNo models available.";
    mockState.buildPreparedModelsProviderData.mockResolvedValueOnce({
      ...fixtures.catalog(),
      resolvedDefault: { provider: "openai", model: "fixture-model" },
      refreshWarning,
    });
    const cfg: OpenClawConfig = { channels: { mattermost: { botToken: "exec:secret-ref" } } };
    const handler = createHandler(cfg);
    const deliveredText = `${text}\nPlatform-rendered note.`;
    mockState.sendMessageMattermost.mockResolvedValueOnce(sentMessage(deliveredText));
    await expectProcessing(handler);
    expectSent(text, { cfg, accountId: "default" });
    expectRecorded({
      commandText: "models",
      replyText: deliveredText,
      commandId: expect.stringMatching(/^mattermost:default:chan-1:/),
    });
  });

  it.each([
    ["/model", "summary", "providers", "/oc_model <provider/model> to switch"],
    ["/models", "providers", "list", "Select a provider:"],
    ["/models openai", "models", "select", "Select a model to switch immediately."],
  ])("sends real %s menu with current catalog status", async (commandText, kind, action, text) => {
    const failed = commandText !== "/model";
    const state = await createOpenClawTestState({
      label: "mattermost-menu-pin",
      applyEnv: false,
    });
    onTestFinished(() => state.cleanup());
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = { session: { store: storePath } };
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      providerOverride: "openai",
      authProfileOverride: "openai:previous",
      authProfileOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
    };
    const saveSession = (entry: SessionEntry) =>
      upsertSessionEntry({
        agentId: "agent-1",
        storePath,
        sessionKey: "agent:agent-1:mattermost:session:1",
        entry,
      });
    await saveSession(sessionEntry);
    mockState.resolveCommandText.mockReturnValueOnce(commandText);
    const entry = kind === "models" ? { kind, provider: "openai" } : { kind };
    mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(entry);
    mockState.buildPreparedModelsProviderData.mockResolvedValueOnce({
      ...fixtures.catalog(),
      byProvider: new Map([["openai", new Set(["fixture-model"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "fixture-model" },
      modelNames: new Map([["openai/fixture-model", "Fixture model"]]),
      refreshWarning: failed ? "Some models could not be refreshed." : undefined,
    });
    const handler = createHandler(cfg);

    await saveSession({ ...sessionEntry, authProfileOverride: "openai:current", updatedAt: 2 });

    await expectProcessing(handler);
    expect(mockState.buildPreparedModelsProviderData).toHaveBeenCalledExactlyOnceWith(
      cfg,
      "agent-1",
      {
        sessionEntry: expect.objectContaining({
          providerOverride: "openai",
          authProfileOverride: "openai:current",
          authProfileOverrideSource: "user",
          agentRuntimeOverride: "openclaw",
        }),
      },
    );
    expect(mockState.sendMessageMattermost).toHaveBeenCalledExactlyOnceWith(
      "channel:chan-1",
      expect.stringContaining(text),
      expect.objectContaining({
        accountId: "default",
        buttons: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              context: expect.objectContaining({ action }),
            }),
          ]),
        ]),
        cfg,
      }),
    );
    const sentText = mockState.sendMessageMattermost.mock.calls[0]?.[1];
    expect(sentText?.includes("Some models could not be refreshed.")).toBe(failed);
    expectRecorded({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:mattermost:session:1",
      expectedSessionId: sessionEntry.sessionId,
      commandText,
      replyText: expect.stringContaining(text),
    });
  });

  it("keeps the slash team scope on direct conversations", async () => {
    mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(null);
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      ...fixtures.payload,
      command: "/oc_status",
      text: "status",
      channel_id: "dm-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      ...fixtures.command,
      id: "cmd-status",
      trigger: "oc_status",
    });
    mockState.authorizeMattermostCommandInvocation.mockReturnValueOnce({
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "dm-1", type: "D", name: "alice", display_name: "Alice" },
      kind: "direct",
      chatType: "direct",
      channelName: "alice",
      channelDisplay: "Alice",
      roomLabel: "Alice",
    });
    const handler = createHandler({}, { id: "cmd-status", trigger: "oc_status" });

    await handler(createRequest(), createMockServerResponse());

    expect(mockState.dispatchInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        ctxPayload: expect.objectContaining({
          ChatType: "direct",
          ConversationRouteContextObserved: true,
          ConversationRoutePeerId: "user-1",
          GroupSpace: "team-1",
        }),
      }),
    );
  });
  describe("command typed in a thread", () => {
    beforeEach(() => {
      mockState.parseSlashCommandPayload.mockReturnValue({
        ...fixtures.payload,
        text: "status",
        root_id: "root-1",
      });
    });

    it("dispatches and delivers the command in its thread session", async () => {
      mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(null);
      mockState.dispatchInbound.mockImplementationOnce(async (params) => {
        await params.replyPipeline?.typing?.start?.();
        await params.delivery.deliver({ text: "Status: ok" }, { kind: "final" });
      });
      vi.mocked(deliverMattermostReplyPayload).mockResolvedValueOnce({
        outcome: "text",
        visibleReplySent: true,
      });

      await expectProcessing(createHandler({}));

      expect(deliverMattermostReplyPayload).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "chan-1", replyToId: "root-1" }),
      );
      expect(sendMattermostTyping).toHaveBeenCalledWith(expect.anything(), {
        channelId: "chan-1",
        parentId: "root-1",
      });
      expect(mockState.dispatchInbound).toHaveBeenCalledWith(
        expect.objectContaining({
          route: expect.objectContaining({
            sessionKey: "agent:agent-1:mattermost:session:1:thread:root-1",
          }),
          ctxPayload: expect.objectContaining({
            SessionKey: "agent:agent-1:mattermost:session:1:thread:root-1",
            ParentSessionKey: "agent:agent-1:mattermost:session:1",
            MessageThreadId: "root-1",
          }),
        }),
      );
    });

    it("posts the model picker in the thread and records its session", async () => {
      await expectProcessing(createHandler({}));

      expectSent("No models available.", { replyToId: "root-1" });
      expectRecorded({ sessionKey: "agent:agent-1:mattermost:session:1:thread:root-1" });
    });

    it("posts the error fallback in the thread", async () => {
      mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(null);
      mockState.dispatchInbound.mockRejectedValueOnce(new Error("boom"));

      await expectProcessing(createHandler({}));

      expectSent("Sorry, something went wrong processing that command.", { replyToId: "root-1" });
    });
  });
});
