import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "../../test-utils/send-config.js";
import type { IrcClient } from "./client.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => {
  const loadConfig = vi.fn();
  const resolveMarkdownTableMode = vi.fn(() => "preserve");
  const convertMarkdownTables = vi.fn((text: string) => text);
  const record = vi.fn();
  return {
    loadConfig,
    resolveMarkdownTableMode,
    convertMarkdownTables,
    record,
    resolveIrcAccount: vi.fn(() => ({
      configured: true,
      accountId: "default",
      host: "irc.example.com",
      nick: "openclaw",
      port: 6697,
      tls: true,
    })),
    normalizeIrcMessagingTarget: vi.fn((value: string) => value.trim()),
    connectIrcClient: vi.fn(),
    buildIrcConnectOptions: vi.fn(() => ({})),
  };
});

vi.mock("./runtime.js", () => ({
  getIrcRuntime: () => createSendCfgThreadingRuntime(hoisted),
}));

vi.mock("./accounts.js", () => ({
  resolveIrcAccount: hoisted.resolveIrcAccount,
}));

vi.mock("./normalize.js", () => ({
  normalizeIrcMessagingTarget: hoisted.normalizeIrcMessagingTarget,
}));

vi.mock("./client.js", () => ({
  connectIrcClient: hoisted.connectIrcClient,
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: hoisted.buildIrcConnectOptions,
}));

vi.mock("./protocol.js", async () => {
  const actual = await vi.importActual<typeof import("./protocol.js")>("./protocol.js");
  return {
    ...actual,
    makeIrcMessageId: () => "irc-msg-1",
  };
});

import { sendMessageIrc } from "./send.js";

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses explicitly provided cfg without loading runtime config", async () => {
    const providedCfg = { source: "provided" } as unknown as CoreConfig;
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;

    const result = await sendMessageIrc("#room", "hello", {
      cfg: providedCfg,
      client,
      accountId: "work",
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveIrcAccount,
      cfg: providedCfg,
      accountId: "work",
    });
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello");
    expect(result).toEqual({ messageId: "irc-msg-1", target: "#room" });
  });

  it("falls back to runtime config when cfg is omitted", async () => {
    const runtimeCfg = { source: "runtime" } as unknown as CoreConfig;
    hoisted.loadConfig.mockReturnValueOnce(runtimeCfg);
    const client = {
      isReady: vi.fn(() => true),
      sendPrivmsg: vi.fn(),
    } as unknown as IrcClient;

    await sendMessageIrc("#ops", "ping", { client });

    expectRuntimeCfgFallback({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveIrcAccount,
      cfg: runtimeCfg,
      accountId: undefined,
    });
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#ops", "ping");
  });
});
