import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkAccountMock = vi.hoisted(() => vi.fn());
const recordActivityMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime.js", () => ({
  getNextcloudTalkRuntime: () => ({
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
  resolveNextcloudTalkAccount: resolveNextcloudTalkAccountMock,
}));

vi.mock("./signature.js", () => ({
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "random",
    signature: "signature",
  })),
}));

import { sendMessageNextcloudTalk } from "./send.js";

describe("sendMessageNextcloudTalk cfg threading", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveNextcloudTalkAccountMock.mockReset();
    recordActivityMock.mockReset();

    const runtimeCfg: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          baseUrl: "https://runtime.example.com",
          botSecret: "runtime-secret",
        },
      },
    };
    loadConfigMock.mockReturnValue(runtimeCfg);

    resolveNextcloudTalkAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      baseUrl: "https://resolved.example.com",
      secret: "resolved-secret",
      secretSource: "config",
      config: {},
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ocs: {
            data: {
              id: "msg-1",
              timestamp: 1700000000,
            },
          },
        }),
      })),
    );
  });

  it("prefers opts.cfg over runtime loadConfig when resolving account", async () => {
    const resolvedCfg: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          baseUrl: "https://resolved.example.com",
          botSecret: "resolved-secret",
        },
      },
    };

    await sendMessageNextcloudTalk("room:test", "hello", { cfg: resolvedCfg });

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(resolveNextcloudTalkAccountMock).toHaveBeenCalledWith({
      cfg: resolvedCfg,
      accountId: undefined,
    });
  });
});
