import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "../../../test/helpers/extensions/send-config.js";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(() => ({
    accountId: "default",
    baseUrl: "https://nextcloud.example.com",
    secret: "secret-value", // pragma: allowlist secret
  })),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
}));

vi.mock("./runtime.js", () => ({
  getNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
}));

vi.mock("./accounts.js", () => ({
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
}));

vi.mock("./signature.js", () => ({
  generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
}));

import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses provided cfg for sendMessage and skips runtime loadConfig", async () => {
    const cfg = { source: "provided" } as const;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { id: 12345, timestamp: 1_706_000_000 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg,
      accountId: "work",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messageId: "12345",
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
  });

  it("falls back to runtime cfg for sendReaction when cfg is omitted", async () => {
    const runtimeCfg = { source: "runtime" } as const;
    hoisted.loadConfig.mockReturnValueOnce(runtimeCfg);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      accountId: "default",
    });

    expect(result).toEqual({ ok: true });
    expectRuntimeCfgFallback({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg: runtimeCfg,
      accountId: "default",
    });
  });
});
