import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveIrcAccountMock = vi.hoisted(() => vi.fn());
const recordActivityMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime.js", () => ({
  getIrcRuntime: () => ({
    config: {
      loadConfig: loadConfigMock,
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
      },
      activity: {
        record: recordActivityMock,
      },
    },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveIrcAccount: resolveIrcAccountMock,
}));

vi.mock("./protocol.js", () => ({
  makeIrcMessageId: () => "irc-msg-1",
}));

import { sendMessageIrc } from "./send.js";

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveIrcAccountMock.mockReset();
    recordActivityMock.mockReset();

    const runtimeCfg: CoreConfig = {
      channels: {
        irc: {
          enabled: true,
          host: "runtime.example.com",
          nick: "runtime-bot",
          password: "runtime-secret",
        },
      },
    };
    loadConfigMock.mockReturnValue(runtimeCfg);

    resolveIrcAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      host: "resolved.example.com",
      port: 6697,
      tls: true,
      nick: "resolved-bot",
      username: "resolved-bot",
      realname: "OpenClaw",
      password: "resolved-secret",
      passwordSource: "config",
      config: {},
    });
  });

  it("prefers opts.cfg over runtime loadConfig when resolving account", async () => {
    const resolvedCfg: CoreConfig = {
      channels: {
        irc: {
          enabled: true,
          host: "resolved.example.com",
          nick: "resolved-bot",
          password: "resolved-secret",
        },
      },
    };
    const client = {
      isReady: () => true,
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    };

    await sendMessageIrc("#general", "hello", { cfg: resolvedCfg, client } as never);

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(resolveIrcAccountMock).toHaveBeenCalledWith({
      cfg: resolvedCfg,
      accountId: undefined,
    });
  });

  it("falls back to runtime loadConfig when opts.cfg is omitted", async () => {
    const client = {
      isReady: () => true,
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
    };

    await sendMessageIrc("#general", "hello", { client } as never);

    expect(loadConfigMock).toHaveBeenCalledOnce();
    expect(resolveIrcAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            irc: expect.objectContaining({
              host: "runtime.example.com",
            }),
          }),
        }),
      }),
    );
  });
});
