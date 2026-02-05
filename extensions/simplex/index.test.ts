import { afterEach, describe, expect, it, vi } from "vitest";

type MockResponse = { [key: string]: unknown };

let mockSendResponse: MockResponse = { resp: { type: "ok" } };
let lastCommand: string | null = null;

const qrMocks = vi.hoisted(() => ({
  renderQrPngBase64: vi.fn(async () => "mock-base64"),
}));

vi.mock("./src/simplex-ws-client.js", () => ({
  SimplexWsClient: class {
    async connect() {}
    async sendCommand(cmd: string) {
      lastCommand = cmd;
      return mockSendResponse;
    }
    async close() {}
  },
  __setMockResponse: (next: MockResponse) => {
    mockSendResponse = next;
  },
  __getLastCommand: () => lastCommand,
  __resetMock: () => {
    lastCommand = null;
    mockSendResponse = { resp: { type: "ok" } };
  },
}));

vi.mock("../../src/web/qr-image.js", () => ({
  renderQrPngBase64: qrMocks.renderQrPngBase64,
}));

import type { PluginRuntime } from "openclaw/plugin-sdk";
import plugin from "./index.js";
import { __getLastCommand, __resetMock, __setMockResponse } from "./src/simplex-ws-client.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type Handler = (ctx: {
  params?: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, err?: unknown) => void;
  context: {
    startChannel: (channel: string, accountId?: string) => Promise<void>;
    getRuntimeSnapshot: () => {
      channels?: Record<string, { running?: boolean }>;
      channelAccounts?: Record<string, Record<string, { running?: boolean }>>;
    };
  };
}) => Promise<void>;

function setupHandler(config: Record<string, unknown> = {}): Handler {
  const methods = new Map<string, Handler>();
  plugin.register({
    id: "simplex",
    name: "SimpleX",
    description: "test",
    version: "0",
    source: "test",
    config,
    pluginConfig: {},
    runtime: {} as PluginRuntime,
    logger: noopLogger,
    registerChannel: () => {},
    registerGatewayMethod: (method, handler) => methods.set(method, handler as Handler),
    registerTool: () => {},
    registerCli: () => {},
    registerService: () => {},
    resolvePath: (value: string) => value,
  });
  const handler = methods.get("simplex.invite.create");
  if (!handler) {
    throw new Error("simplex.invite.create handler not registered");
  }
  return handler;
}

describe("simplex invite gateway", () => {
  afterEach(() => {
    __resetMock();
    vi.clearAllMocks();
  });

  it("rejects invalid mode", async () => {
    const handler = setupHandler({ channels: { simplex: {} } });
    const respond = vi.fn();
    await handler({
      params: { mode: "bad" },
      respond,
      context: {
        startChannel: async () => {},
        getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      },
    });
    expect(respond).toHaveBeenCalled();
    const [ok] = respond.mock.calls[0];
    expect(ok).toBe(false);
  });

  it("returns a simplex invite link + qr data", async () => {
    __setMockResponse({
      resp: {
        type: "ok",
        message: "Use simplex://invite123 or https://example.com",
      },
    });

    const handler = setupHandler({ channels: { simplex: {} } });
    const respond = vi.fn();
    await handler({
      params: { mode: "connect" },
      respond,
      context: {
        startChannel: async () => {},
        getRuntimeSnapshot: () => ({ channels: { simplex: { running: false } }, channelAccounts: {} }),
      },
    });

    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      link: "simplex://invite123",
      qrDataUrl: "data:image/png;base64,mock-base64",
      mode: "connect",
    });
    expect(__getLastCommand()).toBe("/c");
    expect(qrMocks.renderQrPngBase64).toHaveBeenCalledWith("simplex://invite123");
  });

  it("uses address mode to build invite command", async () => {
    __setMockResponse({
      resp: {
        type: "ok",
        output: "simplex://address456",
      },
    });

    const handler = setupHandler({ channels: { simplex: {} } });
    const respond = vi.fn();
    await handler({
      params: { mode: "address" },
      respond,
      context: {
        startChannel: async () => {},
        getRuntimeSnapshot: () => ({ channels: { simplex: { running: true } }, channelAccounts: {} }),
      },
    });

    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      link: "simplex://address456",
      mode: "address",
    });
    expect(__getLastCommand()).toBe("/ad");
  });
});
