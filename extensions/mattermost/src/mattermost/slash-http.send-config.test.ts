// Mattermost tests cover slash http.send config plugin behavior.
import { ServerResponse, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";

type ParseSlashCommandPayload = typeof import("./slash-commands.js").parseSlashCommandPayload;
type BuildModelsProviderData = typeof import("./runtime-api.js").buildModelsProviderData;
type AuthorizeMattermostCommandInvocation =
  typeof import("./monitor-auth.js").authorizeMattermostCommandInvocation;
type FetchMattermostChannel = typeof import("./client.js").fetchMattermostChannel;
type GetMattermostCommand = typeof import("./slash-commands.js").getMattermostCommand;

const mockState = vi.hoisted(() => ({
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
  parseSlashCommandPayload: vi.fn<ParseSlashCommandPayload>(() => ({
    token: "valid-token",
    command: "/oc_models",
    text: "models",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
  })),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
  buildModelsProviderData: vi.fn<BuildModelsProviderData>(async () => ({
    providers: [],
    byProvider: new Map(),
    resolvedDefault: {
      provider: "",
      model: "",
    },
    modelNames: new Map(),
  })),
  resolveMattermostModelPickerEntry: vi.fn(() => ({ kind: "summary" })),
  buildMattermostModelPickerDialog: vi.fn(() => ({
    callback_id: "oc_model_picker",
    title: "Model Picker",
    elements: [],
  })),
  resolveMattermostModelPickerCurrentRuntime: vi.fn(() => "auto"),
  authorizeMattermostCommandInvocation: vi.fn<AuthorizeMattermostCommandInvocation>(async () => ({
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
  openMattermostInteractiveDialog: vi.fn(async () => undefined),
  fetchMattermostChannel: vi.fn<FetchMattermostChannel>(async () => ({
    id: "chan-1",
    type: "O",
    name: "town-square",
    display_name: "Town Square",
  })),
  sendMessageMattermost: vi.fn(async () => ({ messageId: "post-1", channelId: "chan-1" })),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
  getMattermostCommand: vi.fn<GetMattermostCommand>(async () => ({
    id: "cmd-1",
    token: "valid-token",
    team_id: "team-1",
    trigger: "oc_models",
    method: "P",
    url: "https://gateway.example.com/slash",
    auto_complete: true,
    delete_at: 0,
  })),
  listMattermostCommands: vi.fn(async () => []),
}));

vi.mock("./runtime-api.js", () => {
  return {
    buildModelsProviderData: mockState.buildModelsProviderData,
    createChannelMessageReplyPipeline: vi.fn(() => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
    })),
    createDedupeCache: vi.fn(() => ({
      check: () => false,
    })),
    createReplyPrefixOptions: vi.fn(() => ({})),
    createTypingCallbacks: vi.fn(() => ({ onReplyStart: vi.fn() })),
    isRequestBodyLimitError: vi.fn(() => false),
    logTypingFailure: vi.fn(),
    formatInboundFromLabel: vi.fn(() => ""),
    rawDataToString: vi.fn((value: unknown) => (typeof value === "string" ? value : "")),
    readRequestBodyWithLimit: mockState.readRequestBodyWithLimit,
    resolveThreadSessionKeys: vi.fn((params: { baseSessionKey: string }) => ({
      sessionKey: params.baseSessionKey,
      parentSessionKey: undefined,
    })),
  };
});

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      text: {
        hasControlCommand: () => false,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "mattermost:session:1",
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
    openMattermostInteractiveDialog: mockState.openMattermostInteractiveDialog,
    sendMattermostTyping: vi.fn(),
  };
});

vi.mock("./model-picker.js", () => ({
  buildMattermostModelPickerDialog: mockState.buildMattermostModelPickerDialog,
  renderMattermostModelSummaryView: vi.fn(),
  renderMattermostModelsPickerView: vi.fn(),
  renderMattermostProviderPickerView: vi.fn(),
  resolveMattermostModelPickerCurrentModel: vi.fn(),
  resolveMattermostModelPickerCurrentRuntime: mockState.resolveMattermostModelPickerCurrentRuntime,
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
const callbackUrlFixture = "https://gateway.example.com/slash";

function createRequest(body = "token=valid-token"): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as PassThrough & IncomingMessage;
  incoming.method = "POST";
  incoming.url = "/slash";
  incoming.headers = {
    "content-type": "application/x-www-form-urlencoded",
  };
  process.nextTick(() => {
    req.end(body);
  });
  return incoming;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  class TestServerResponse extends ServerResponse {
    override setHeader() {
      return this;
    }

    override end(): this;
    override end(cb: () => void): this;
    override end(chunk: string | Buffer | Uint8Array, cb?: () => void): this;
    override end(
      chunk: string | Buffer | Uint8Array,
      encoding: BufferEncoding,
      cb?: () => void,
    ): this;
    override end(
      chunkOrCb?: string | Buffer | Uint8Array | (() => void),
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): this {
      const chunk = typeof chunkOrCb === "function" ? undefined : chunkOrCb;
      const callback =
        typeof chunkOrCb === "function"
          ? chunkOrCb
          : typeof encodingOrCb === "function"
            ? encodingOrCb
            : cb;
      body = chunk ? String(chunk) : "";
      callback?.();
      return this;
    }
  }

  const res = new TestServerResponse(createRequest(""));
  return {
    res,
    getBody: () => body,
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

describe("slash-http cfg threading", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.readRequestBodyWithLimit.mockClear();
    mockState.parseSlashCommandPayload.mockClear();
    mockState.resolveCommandText.mockClear();
    mockState.buildModelsProviderData.mockClear();
    mockState.buildMattermostModelPickerDialog.mockClear();
    mockState.resolveMattermostModelPickerEntry.mockClear();
    mockState.resolveMattermostModelPickerCurrentRuntime.mockClear();
    mockState.authorizeMattermostCommandInvocation.mockClear();
    mockState.createMattermostClient.mockClear();
    mockState.openMattermostInteractiveDialog.mockClear();
    mockState.fetchMattermostChannel.mockClear();
    mockState.sendMessageMattermost.mockClear();
    mockState.normalizeMattermostAllowList.mockClear();
    mockState.getMattermostCommand.mockClear();
    mockState.listMattermostCommands.mockClear();
    ({ createSlashCommandHttpHandler } = await import("./slash-http.js"));
  });

  it("passes cfg through the no-models slash reply send path", async () => {
    const cfg = {
      channels: {
        mattermost: {
          botToken: "exec:secret-ref",
        },
      },
    } as OpenClawConfig;
    const handler = createSlashCommandHttpHandler({
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
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "No models available.",
      {
        cfg,
        accountId: "default",
      },
    );
  });

  it("opens the dialog-backed picker synchronously when Mattermost provides a trigger id", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "valid-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
      trigger_id: "trigger-1",
    });
    mockState.buildModelsProviderData.mockResolvedValueOnce({
      providers: ["openai"],
      byProvider: new Map([["openai", new Set(["gpt-5"])]]),
      resolvedDefault: {
        provider: "openai",
        model: "gpt-5",
      },
      modelNames: new Map(),
    });
    mockState.createMattermostClient.mockReturnValue({});

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain('"text":""');
    expect(mockState.openMattermostInteractiveDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        triggerId: "trigger-1",
      }),
    );
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("falls back to payload-derived channel info when channel lookup is forbidden", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "valid-token",
      command: "/oc_model",
      text: "",
      channel_id: "chan-private-1",
      channel_name: "secret-planning",
      user_id: "1a358pib8ffm9cwme4z8c1z5uc",
      user_name: "alice",
      team_id: "team-1",
      trigger_id: "trigger-private-1",
    });
    mockState.fetchMattermostChannel.mockRejectedValueOnce(
      new Error("Mattermost API 403 Forbidden: You do not have the appropriate permissions."),
    );
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-1",
      token: "valid-token",
      team_id: "team-1",
      trigger: "oc_model",
      method: "P",
      url: callbackUrlFixture,
      auto_complete: true,
      delete_at: 0,
    });
    mockState.authorizeMattermostCommandInvocation.mockImplementationOnce(
      async ({ channelInfo }) => {
        const resolvedChannelInfo = channelInfo ?? {
          id: "chan-private-1",
          type: "O",
          name: "secret-planning",
          display_name: "secret-planning",
          team_id: "team-1",
        };
        return {
          ok: true,
          commandAuthorized: true,
          channelInfo: resolvedChannelInfo,
          kind: "channel",
          chatType: "channel",
          channelName: resolvedChannelInfo.name ?? "",
          channelDisplay: resolvedChannelInfo.display_name ?? resolvedChannelInfo.name ?? "",
          roomLabel: `#${resolvedChannelInfo.name ?? "chan-private-1"}`,
        };
      },
    );
    mockState.buildModelsProviderData.mockResolvedValueOnce({
      providers: ["openai"],
      byProvider: new Map([["openai", new Set(["gpt-5"])]]),
      resolvedDefault: {
        provider: "openai",
        model: "gpt-5",
      },
      modelNames: new Map(),
    });
    mockState.createMattermostClient.mockReturnValue({});

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_model",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain('"text":""');
    expect(mockState.authorizeMattermostCommandInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInfo: expect.objectContaining({
          id: "chan-private-1",
          name: "secret-planning",
          type: "O",
          team_id: "team-1",
        }),
      }),
    );
    expect(mockState.buildMattermostModelPickerDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInfo: expect.objectContaining({
          id: "chan-private-1",
          name: "secret-planning",
          type: "O",
          team_id: "team-1",
        }),
      }),
    );
    expect(mockState.openMattermostInteractiveDialog).toHaveBeenCalled();
  });

  it("infers direct-message slash payloads without channel lookup access", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "valid-token",
      command: "/oc_model",
      text: "",
      channel_id: "chan-dm-1",
      channel_name: "1a358pib8ffm9cwme4z8c1z5uc__tnrrznrcsj81pqdi8kwoedrfby",
      user_id: "1a358pib8ffm9cwme4z8c1z5uc",
      user_name: "alice",
      team_id: "team-1",
      trigger_id: "trigger-dm-1",
    });
    mockState.fetchMattermostChannel.mockRejectedValueOnce(
      new Error("Mattermost API 403 Forbidden: You do not have the appropriate permissions."),
    );
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-1",
      token: "valid-token",
      team_id: "team-1",
      trigger: "oc_model",
      method: "P",
      url: callbackUrlFixture,
      auto_complete: true,
      delete_at: 0,
    });
    mockState.authorizeMattermostCommandInvocation.mockImplementationOnce(
      async ({ channelInfo }) => {
        const resolvedChannelInfo = channelInfo ?? {
          id: "chan-dm-1",
          type: "D",
          name: "1a358pib8ffm9cwme4z8c1z5uc__tnrrznrcsj81pqdi8kwoedrfby",
          display_name: "1a358pib8ffm9cwme4z8c1z5uc__tnrrznrcsj81pqdi8kwoedrfby",
          team_id: "team-1",
        };
        return {
          ok: true,
          commandAuthorized: true,
          channelInfo: resolvedChannelInfo,
          kind: "direct",
          chatType: "direct",
          channelName: resolvedChannelInfo.name ?? "",
          channelDisplay: resolvedChannelInfo.display_name ?? resolvedChannelInfo.name ?? "",
          roomLabel: `#${resolvedChannelInfo.name ?? "chan-dm-1"}`,
        };
      },
    );
    mockState.buildModelsProviderData.mockResolvedValueOnce({
      providers: ["openai"],
      byProvider: new Map([["openai", new Set(["gpt-5"])]]),
      resolvedDefault: {
        provider: "openai",
        model: "gpt-5",
      },
      modelNames: new Map(),
    });
    mockState.createMattermostClient.mockReturnValue({});

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_model",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain('"text":""');
    expect(mockState.authorizeMattermostCommandInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInfo: expect.objectContaining({
          id: "chan-dm-1",
          name: "1a358pib8ffm9cwme4z8c1z5uc__tnrrznrcsj81pqdi8kwoedrfby",
          type: "D",
          team_id: "team-1",
        }),
      }),
    );
    expect(mockState.openMattermostInteractiveDialog).toHaveBeenCalled();
  });

  it("rejects a callback when Mattermost reports a different current command token", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "old-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-1",
      token: "new-token",
      team_id: "team-1",
      trigger: "oc_models",
      method: "P",
      url: callbackUrlFixture,
      auto_complete: true,
      delete_at: 0,
    });

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "old-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest("token=old-token"), response.res);

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
    expect(mockState.fetchMattermostChannel).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("rejects unknown tokens before calling Mattermost", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "unknown-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "valid-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest("token=unknown-token"), response.res);

    expect(response.res.statusCode).toBe(401);
    expect(mockState.getMattermostCommand).not.toHaveBeenCalled();
    expect(mockState.fetchMattermostChannel).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });

  it("rejects a refreshed callback token before Mattermost lookup until local state updates", async () => {
    mockState.parseSlashCommandPayload.mockReturnValueOnce({
      token: "new-token",
      command: "/oc_models",
      text: "models",
      channel_id: "chan-1",
      user_id: "user-1",
      user_name: "alice",
      team_id: "team-1",
    });
    mockState.getMattermostCommand.mockResolvedValueOnce({
      id: "cmd-1",
      token: "new-token",
      team_id: "team-1",
      trigger: "oc_models",
      method: "P",
      url: callbackUrlFixture,
      auto_complete: true,
      delete_at: 0,
    });

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      registeredCommands: [
        {
          id: "cmd-1",
          teamId: "team-1",
          trigger: "oc_models",
          token: "old-token",
          url: callbackUrlFixture,
          managed: false,
        },
      ],
    });
    const response = createResponse();

    await handler(createRequest("token=new-token"), response.res);

    expect(response.res.statusCode).toBe(401);
    expect(response.getBody()).toContain("Unauthorized: invalid command token.");
    expect(mockState.getMattermostCommand).not.toHaveBeenCalled();
    expect(mockState.fetchMattermostChannel).not.toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
  });
});
