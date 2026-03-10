import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerZulipComponentEntries } from "./components-registry.js";
import { readZulipComponentSpec } from "./components.js";
import { sendZulipComponentMessage } from "./send-components.js";
import { sendMessageZulip } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveZulipAccount: vi.fn(() => ({
    accountId: "default",
    botEmail: "bot@example.com",
    botApiKey: "bot-key",
    baseUrl: "https://zulip.example.com",
    config: { widgetsEnabled: true } as Record<string, unknown>,
  })),
  createZulipClient: vi.fn(() => ({
    baseUrl: "https://zulip.example.com",
    botEmail: "bot@example.com",
    request: vi.fn(async () => ({ streams: [] })),
  })),
  normalizeZulipBaseUrl: vi.fn((input: string | undefined) => input?.trim()),
  fetchZulipStreams: vi.fn(async () => [{ name: "ops" }]),
  sendZulipStreamMessageWithWidget: vi.fn(async () => ({ id: 42 })),
  sendZulipDirectMessageWithWidget: vi.fn(async () => ({ id: 99 })),
  uploadZulipFile: vi.fn(),
  registerZulipComponentEntries: vi.fn(),
  sendMessageZulip: vi.fn(async () => ({ messageId: "m1", target: "stream:ops:topic:deploy" })),
  loadWebMedia: vi.fn(),
  recordActivity: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getZulipRuntime: () => ({
    config: { loadConfig: mockState.loadConfig },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    media: { loadWebMedia: mockState.loadWebMedia },
    channel: { activity: { record: mockState.recordActivity } },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: mockState.resolveZulipAccount,
}));

vi.mock("./client.js", () => ({
  createZulipClient: mockState.createZulipClient,
  normalizeZulipBaseUrl: mockState.normalizeZulipBaseUrl,
  fetchZulipStreams: mockState.fetchZulipStreams,
  sendZulipStreamMessageWithWidget: mockState.sendZulipStreamMessageWithWidget,
  sendZulipDirectMessageWithWidget: mockState.sendZulipDirectMessageWithWidget,
  uploadZulipFile: mockState.uploadZulipFile,
}));

vi.mock("./components-registry.js", () => ({
  registerZulipComponentEntries: mockState.registerZulipComponentEntries,
}));

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageZulip: mockState.sendMessageZulip,
  };
});

describe("sendZulipComponentMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveZulipAccount.mockReturnValue({
      accountId: "default",
      botEmail: "bot@example.com",
      botApiKey: "bot-key",
      baseUrl: "https://zulip.example.com",
      config: { widgetsEnabled: true, streams: {} } as Record<string, unknown>,
    });
    mockState.createZulipClient.mockReturnValue({
      baseUrl: "https://zulip.example.com",
      botEmail: "bot@example.com",
      request: vi.fn(async () => ({ streams: [] })),
    });
    mockState.fetchZulipStreams.mockResolvedValue([{ name: "ops" }]);
    mockState.sendZulipStreamMessageWithWidget.mockResolvedValue({ id: 42 });
    mockState.sendZulipDirectMessageWithWidget.mockResolvedValue({ id: 99 });
    mockState.sendMessageZulip.mockResolvedValue({
      messageId: "m1",
      target: "stream:ops:topic:deploy",
    });
  });

  it("sends stream widgets and registers callback entries with reply routing", async () => {
    const result = await sendZulipComponentMessage(
      "stream:ops:topic:deploy",
      "Pick one",
      {
        heading: "Choose",
        buttons: [{ label: "Approve", callbackData: "approve", style: "success" }],
      },
      {
        sessionKey: "sess-1",
        agentId: "archie",
      },
    );

    expect(mockState.sendZulipStreamMessageWithWidget).toHaveBeenCalledTimes(1);
    expect(mockState.registerZulipComponentEntries).toHaveBeenCalledTimes(1);
    const args = vi.mocked(registerZulipComponentEntries).mock.calls[0]?.[0];
    expect(args?.messageId).toBe(42);
    expect(args?.entries[0]).toMatchObject({
      sessionKey: "sess-1",
      agentId: "archie",
      callbackData: "approve",
      replyTo: "stream:ops:topic:deploy",
      chatType: "channel",
    });
    expect(result).toEqual({ messageId: "42", target: "stream:ops:topic:deploy" });
  });

  it("falls back to markdown text when widgets are disabled", async () => {
    mockState.resolveZulipAccount.mockReturnValue({
      accountId: "default",
      botEmail: "bot@example.com",
      botApiKey: "bot-key",
      baseUrl: "https://zulip.example.com",
      config: { widgetsEnabled: false, streams: {} } as Record<string, unknown>,
    });

    await sendZulipComponentMessage(
      "stream:ops:topic:deploy",
      "Pick one",
      {
        heading: "Choose",
        buttons: [{ label: "Approve", callbackData: "approve" }],
      },
      {
        sessionKey: "sess-1",
        agentId: "archie",
      },
    );

    expect(vi.mocked(sendMessageZulip)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessageZulip)).toHaveBeenCalledWith(
      "stream:ops:topic:deploy",
      expect.stringContaining("Approve"),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(mockState.registerZulipComponentEntries).not.toHaveBeenCalled();
  });
});

describe("readZulipComponentSpec", () => {
  it("accepts telegram-style button rows and preserves callback_data", () => {
    const spec = readZulipComponentSpec({
      heading: "Model",
      buttons: [[{ text: "Fast", callback_data: "model:fast", style: "primary" }]],
    });

    expect(spec).toEqual({
      heading: "Model",
      buttons: [{ label: "Fast", callbackData: "model:fast", style: "primary" }],
    });
  });
});
