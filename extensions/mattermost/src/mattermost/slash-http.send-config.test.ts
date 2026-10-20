import type { IncomingMessage } from "node:http";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { upsertSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type * as MattermostRuntime from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostRegisteredCommand } from "./slash-commands.js";

type BuildPreparedModelsProviderData =
  typeof import("./runtime-api.js").buildPreparedModelsProviderData;

const mockState = vi.hoisted(() => ({
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
  parseSlashCommandPayload: vi.fn(() => ({
    token: "valid-token",
    command: "/oc_models",
    text: "models",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
  })),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
  buildPreparedModelsProviderData: vi.fn<BuildPreparedModelsProviderData>(async () => ({
    byProvider: new Map(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-5.5" },
    modelCatalog: [],
    modelNames: new Map(),
  })),
  resolveMattermostModelPickerEntry: vi.fn((): { kind: string } | null => ({ kind: "summary" })),
  authorizeMattermostCommandInvocation: vi.fn(() => ({
    ok: true,
    commandAuthorized: true,
    channelInfo: { id: "chan-1", type: "O", name: "town-square", display_name: "Town Square" },
    kind: "channel",
    chatType: "channel",
    channelName: "town-square",
    channelDisplay: "Town Square",
    roomLabel: "#town-square",
  })),
  createMattermostClient: vi.fn(() => ({})),
  fetchMattermostChannel: vi.fn(async () => ({
    id: "chan-1",
    type: "O",
    name: "town-square",
    display_name: "Town Square",
  })),
  sendMessageMattermost: vi.fn<typeof import("./send.js").sendMessageMattermost>(
    async (_target, content) => sentMessage(content),
  ),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
  getMattermostCommand: vi.fn(async () => ({
    id: "cmd-1",
    token: "valid-token",
    team_id: "team-1",
    trigger: "oc_models",
    method: "P",
    url: "https://gateway.example.com/slash",
    delete_at: 0,
  })),
  listMattermostCommands: vi.fn(async () => []),
  dispatchInbound: vi.fn(async () => undefined),
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

let createSlashCommandHttpHandler: typeof import("./slash-http.js").createSlashCommandHttpHandler;
let clearMattermostSlashCommandValidationCacheForAccount: typeof import("./slash-http.js").clearMattermostSlashCommandValidationCacheForAccount;
const callbackUrlFixture = "https://gateway.example.com/slash";

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
        url: callbackUrlFixture,
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

describe("slash-http cfg threading", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createSlashCommandHttpHandler, clearMattermostSlashCommandValidationCacheForAccount } =
      await import("./slash-http.js"));
  });

  afterEach(() => {
    clearMattermostSlashCommandValidationCacheForAccount(accountFixture.accountId);
  });

  beforeEach(() => Object.values(mockState).forEach((mock) => mock.mockReset()));

  it("passes cfg and catalog status through the no-models slash reply", async () => {
    const refreshWarning = "Some models could not be refreshed.";
    const text = "Some models could not be refreshed.\n\nNo models available.";
    mockState.buildPreparedModelsProviderData.mockResolvedValueOnce({
      byProvider: new Map(),
      providers: [],
      modelNames: new Map(),
      modelCatalog: [],
      resolvedDefault: { provider: "openai", model: "fixture-model" },
      refreshWarning,
    });
    const cfg: OpenClawConfig = { channels: { mattermost: { botToken: "exec:secret-ref" } } };
    const handler = createHandler(cfg);
    const deliveredText = `${text}\nPlatform-rendered note.`;
    mockState.sendMessageMattermost.mockResolvedValueOnce(sentMessage(deliveredText));
    await expectProcessing(handler);
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      text,
      expect.objectContaining({ cfg, accountId: "default" }),
    );
    expect(mockState.recordDeliveredCommandExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: "models",
        replyText: deliveredText,
        commandId: expect.stringMatching(/^mattermost:default:chan-1:/),
      }),
    );
  });

  it.each(
    [
      {
        commandText: "/model",
        entry: { kind: "summary" },
        action: "providers",
        text: "/oc_model <provider/model> to switch",
      },
      {
        commandText: "/models",
        entry: { kind: "providers" },
        action: "list",
        text: "Select a provider:",
      },
      {
        commandText: "/models openai",
        entry: { kind: "models", provider: "openai" },
        action: "select",
        text: "Select a model to switch immediately.",
      },
    ].map((entry) => ({ entry, failed: entry.commandText !== "/model" })),
  )(
    "sends real $entry.commandText menu with current catalog status (failed: $failed)",
    async ({ entry: testCase, failed }) => {
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
      mockState.resolveCommandText.mockReturnValueOnce(testCase.commandText);
      mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(testCase.entry);
      mockState.buildPreparedModelsProviderData.mockResolvedValueOnce({
        byProvider: new Map([["openai", new Set(["fixture-model"])]]),
        providers: ["openai"],
        resolvedDefault: { provider: "openai", model: "fixture-model" },
        modelCatalog: [],
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
        expect.stringContaining(testCase.text),
        expect.objectContaining({
          accountId: "default",
          buttons: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                context: expect.objectContaining({ action: testCase.action }),
              }),
            ]),
          ]),
          cfg,
        }),
      );
      const sentText = mockState.sendMessageMattermost.mock.calls[0]?.[1];
      expect(sentText?.includes("Some models could not be refreshed.")).toBe(failed);
      expect(mockState.recordDeliveredCommandExchange).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          sessionKey: "agent:agent-1:mattermost:session:1",
          expectedSessionId: sessionEntry.sessionId,
          commandText: testCase.commandText,
          replyText: expect.stringContaining(testCase.text),
        }),
      );
    },
  );

  it("keeps the slash team scope on direct conversations", async () => {
    mockState.resolveMattermostModelPickerEntry.mockReturnValueOnce(null);
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "valid-token",
      command: "/oc_status",
      text: "status",
      channel_id: "dm-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-status",
      token: "valid-token",
      team_id: "team-1",
      trigger: "oc_status",
      method: "P",
      url: callbackUrlFixture,
      delete_at: 0,
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
});
