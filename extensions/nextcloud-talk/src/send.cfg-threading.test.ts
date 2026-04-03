import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "../../../test/helpers/plugins/send-config.js";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  mockFetchGuard: vi.fn(),
}));

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    getNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
  };
});

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
  };
});

vi.mock("./signature.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./signature.js")>();
  return {
    ...actual,
    generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
  };
});

vi.mock("../../../src/infra/net/fetch-guard.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
  };
});

vi.mock("openclaw/plugin-sdk/text-runtime", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    convertMarkdownTables: hoisted.convertMarkdownTables,
  };
});

const accountsActual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
hoisted.resolveNextcloudTalkAccount.mockImplementation(accountsActual.resolveNextcloudTalkAccount);

const { sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js");

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Route the SSRF guard mock through the global fetch mock.
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.resolveNextcloudTalkAccount.mockImplementation(
      accountsActual.resolveNextcloudTalkAccount,
    );
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.unstubAllGlobals();
  });

  it("uses provided cfg for sendMessage and skips runtime loadConfig", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example.com",
      secret: "secret-value", // pragma: allowlist secret
    });
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
    expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nextcloud-talk",
      accountId: "default",
    });
    expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(hoisted.record).toHaveBeenCalledWith({
      channel: "nextcloud-talk",
      accountId: "default",
      direction: "outbound",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messageId: "12345",
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
  });

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example.com",
      secret: "secret-value",
    });
    hoisted.record.mockImplementation(() => {
      throw new Error("Nextcloud Talk runtime not initialized");
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { id: 12346, timestamp: 1_706_000_001 } },
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
    expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nextcloud-talk",
      accountId: "default",
    });
    expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(result).toEqual({
      messageId: "12346",
      roomToken: "abc123",
      timestamp: 1_706_000_001,
    });
  });

  it("falls back to runtime cfg for sendReaction when cfg is omitted", async () => {
    const runtimeCfg = { source: "runtime" } as const;
    hoisted.loadConfig.mockReturnValueOnce(runtimeCfg);
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example.com",
      secret: "secret-value", // pragma: allowlist secret
    });
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
