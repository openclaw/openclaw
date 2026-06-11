import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedFactory:
  | ((params: { cfg: OpenClawConfig; target: Record<string, unknown> }) => unknown)
  | undefined;
const registerEchoRendererFactoryMock = vi.fn((factory: typeof capturedFactory) => {
  capturedFactory = factory;
});

vi.mock("openclaw/plugin-sdk/reply-chunking", () => ({
  resolveTextChunkLimit: () => 4096,
}));
vi.mock("./account-throttler.js", () => ({
  getOrCreateAccountThrottler: () => () => {},
}));
const accountMock = vi.fn();
vi.mock("./accounts.js", () => ({
  resolveTelegramAccount: (...args: unknown[]) => accountMock(...args),
}));
const streamModeMock = vi.fn();
vi.mock("./bot/helpers.js", () => ({
  resolveTelegramStreamMode: (...args: unknown[]) => streamModeMock(...args),
}));
const resolveClientOptionsMock = vi.fn();
vi.mock("./client-options.js", () => ({
  resolveTelegramClientOptions: (...args: unknown[]) => resolveClientOptionsMock(...args),
}));
const createRendererMock = vi.fn(() => ({ options: {}, finalize: () => {}, dispose: () => {} }));
vi.mock("./echo-renderer.js", () => ({
  createTelegramEchoRenderer: (...args: unknown[]) => createRendererMock(...args),
}));
const botConstructorMock = vi.fn();
vi.mock("grammy", () => ({
  Bot: class {
    api = { config: { use: vi.fn() } };

    constructor(token: string, config?: unknown) {
      botConstructorMock(token, config);
    }
  },
}));

import {
  registerTelegramEchoRenderer,
  resetTelegramEchoRendererRegistrationForTest,
} from "./echo-renderer-register.js";

const cfg = {} as OpenClawConfig;

describe("registerTelegramEchoRenderer", () => {
  beforeEach(() => {
    createRendererMock.mockClear();
    accountMock.mockReset();
    streamModeMock.mockReset();
    resolveClientOptionsMock.mockReset();
    botConstructorMock.mockReset();
    registerEchoRendererFactoryMock.mockClear();
    capturedFactory = undefined;
    resetTelegramEchoRendererRegistrationForTest();
    accountMock.mockReturnValue({ accountId: "default", token: "TOKEN", config: {} });
    streamModeMock.mockReturnValue("progress");
    resolveClientOptionsMock.mockReturnValue(undefined);
    registerTelegramEchoRenderer({
      registrationMode: "full",
      registerEchoRendererFactory: registerEchoRendererFactoryMock,
    });
  });

  it("does not let tool discovery consume the full registration attempt", () => {
    registerEchoRendererFactoryMock.mockClear();
    capturedFactory = undefined;
    resetTelegramEchoRendererRegistrationForTest();

    registerTelegramEchoRenderer({
      registrationMode: "tool-discovery",
      registerEchoRendererFactory: registerEchoRendererFactoryMock,
    });
    expect(registerEchoRendererFactoryMock).not.toHaveBeenCalled();

    registerTelegramEchoRenderer({
      registrationMode: "full",
      registerEchoRendererFactory: registerEchoRendererFactoryMock,
    });
    expect(registerEchoRendererFactoryMock).toHaveBeenCalledTimes(1);
    expect(capturedFactory).toBeTypeOf("function");
  });

  it("registers a telegram factory that builds a renderer for a streaming account", () => {
    expect(registerEchoRendererFactoryMock).toHaveBeenCalledTimes(1);
    expect(capturedFactory).toBeTypeOf("function");
    const renderer = capturedFactory?.({
      cfg,
      target: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "default",
        threadId: undefined,
      },
    });
    expect(renderer).toBeTruthy();
    const passed = createRendererMock.mock.calls[0][0] as { chatId: unknown; textLimit: number };
    // chat id normalized (prefix stripped, numeric coerced).
    expect(passed.chatId).toBe(123);
    expect(passed.textLimit).toBe(4096);
  });

  it("constructs the bot with the resolved Telegram client options", () => {
    const client = { apiRoot: "https://telegram.example.test" };
    resolveClientOptionsMock.mockReturnValue(client);

    capturedFactory?.({
      cfg,
      target: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "default",
        threadId: undefined,
      },
    });

    expect(resolveClientOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", token: "TOKEN" }),
    );
    expect(botConstructorMock).toHaveBeenCalledWith("TOKEN", { client });
  });

  it("returns undefined (post-hoc fallback) when the account streams off", () => {
    streamModeMock.mockReturnValue("off");
    const renderer = capturedFactory?.({
      cfg,
      target: { channel: "telegram", to: "999", accountId: "default" },
    });
    expect(renderer).toBeUndefined();
    expect(createRendererMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the account has no token", () => {
    accountMock.mockReturnValue({ accountId: "default", token: "", config: {} });
    const renderer = capturedFactory?.({
      cfg,
      target: { channel: "telegram", to: "999", accountId: "default" },
    });
    expect(renderer).toBeUndefined();
  });

  it("passes a forum thread spec when the target has a threadId", () => {
    capturedFactory?.({
      cfg,
      target: { channel: "telegram", to: "555", accountId: "default", threadId: 42 },
    });
    const passed = createRendererMock.mock.calls[0][0] as {
      thread: { id: number; scope: string } | null;
    };
    expect(passed.thread).toEqual({ id: 42, scope: "forum" });
  });
});
