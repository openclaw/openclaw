import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import type { Api } from "telegram/tl/api.js";
import { describe, expect, it, vi } from "vitest";
import type { UserbotClient } from "./client.js";
import { buildTelegramUserbotOnboardingAdapter, type CreateClientFn } from "./onboarding.js";
import type { SessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(extra: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      "telegram-userbot": {
        ...extra,
      },
    },
  } as unknown as OpenClawConfig;
}

function makePrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    text: vi.fn().mockResolvedValue(""),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue(""),
    multiselect: vi.fn(async () => []),
    note: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  } as unknown as WizardPrompter;
}

const defaults = {
  runtime: {} as never,
  options: undefined,
  accountOverrides: {} as Record<string, string>,
  shouldPromptAccountIds: false,
  forceAllowFrom: false,
};

/** Builds a mock UserbotClient that resolves successfully. */
function makeMockClient(opts?: {
  sessionString?: string;
  username?: string;
  userId?: number;
  connectError?: Error;
}): UserbotClient {
  const sessionStr = opts?.sessionString ?? "mock-session-string";
  const username = opts?.username ?? "testuser";
  const userId = opts?.userId ?? 12345;

  return {
    connectInteractive: opts?.connectError
      ? vi.fn().mockRejectedValue(opts.connectError)
      : vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getSessionString: vi.fn().mockReturnValue(sessionStr),
    getMe: vi.fn().mockResolvedValue({
      username,
      firstName: "Test",
      id: BigInt(userId),
      toString: () => String(userId),
    } as unknown as Api.User),
  } as unknown as UserbotClient;
}

function makeMockSessionStore(): SessionStore {
  const stored = new Map<string, string>();
  return {
    credentialsDir: "/tmp/test-creds",
    getSessionPath: vi.fn((id: string) => `/tmp/test-creds/telegram-userbot-${id}.session`),
    load: vi.fn(async (id: string) => stored.get(id) ?? null),
    save: vi.fn(async (id: string, session: string) => {
      stored.set(id, session);
    }),
    clear: vi.fn(async (id: string) => {
      stored.delete(id);
    }),
    exists: vi.fn(async (id: string) => stored.has(id)),
  } as unknown as SessionStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telegramUserbotOnboardingAdapter", () => {
  describe("getStatus", () => {
    it("returns unconfigured when no config", async () => {
      const store = makeMockSessionStore();
      const adapter = buildTelegramUserbotOnboardingAdapter({ sessionStore: store });

      const status = await adapter.getStatus({
        cfg: {} as OpenClawConfig,
        accountOverrides: {},
      });

      expect(status.configured).toBe(false);
      expect(status.channel).toBe("telegram-userbot");
    });

    it("returns unconfigured when apiId/apiHash present but no session", async () => {
      const store = makeMockSessionStore();
      const adapter = buildTelegramUserbotOnboardingAdapter({ sessionStore: store });

      const status = await adapter.getStatus({
        cfg: makeCfg({ apiId: 12345, apiHash: "abc123hash0123456789" }),
        accountOverrides: {},
      });

      expect(status.configured).toBe(false);
    });

    it("returns configured when apiId+apiHash present AND session exists", async () => {
      const store = makeMockSessionStore();
      await store.save("default", "session-data");
      const adapter = buildTelegramUserbotOnboardingAdapter({ sessionStore: store });

      const status = await adapter.getStatus({
        cfg: makeCfg({ apiId: 12345, apiHash: "abc123hash0123456789" }),
        accountOverrides: {},
      });

      expect(status.configured).toBe(true);
    });

    it("returns not configured when apiId is 0", async () => {
      const store = makeMockSessionStore();
      const adapter = buildTelegramUserbotOnboardingAdapter({ sessionStore: store });

      const status = await adapter.getStatus({
        cfg: makeCfg({ apiId: 0, apiHash: "" }),
        accountOverrides: {},
      });

      expect(status.configured).toBe(false);
    });
  });

  describe("configure", () => {
    it("saves apiId and apiHash to config", async () => {
      const client = makeMockClient();
      const store = makeMockSessionStore();
      const createClient: CreateClientFn = vi.fn(() => client);
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient,
        sessionStore: store,
      });

      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("12345678") // apiId
          .mockResolvedValueOnce("0123456789abcdef0123456789abcdef") // apiHash
          .mockResolvedValueOnce("+15551234567") // phone
          .mockResolvedValueOnce("12345"), // login code
      });

      const result = await adapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      const section = result.cfg.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.apiId).toBe(12345678);
      expect(section.apiHash).toBe("0123456789abcdef0123456789abcdef");
      expect(section.enabled).toBe(true);
    });

    it("saves session string to session store", async () => {
      const client = makeMockClient({ sessionString: "saved-session-xyz" });
      const store = makeMockSessionStore();
      const createClient: CreateClientFn = vi.fn(() => client);
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient,
        sessionStore: store,
      });

      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("12345678") // apiId
          .mockResolvedValueOnce("0123456789abcdef") // apiHash
          .mockResolvedValueOnce("+15551234567") // phone
          .mockResolvedValueOnce("99999"), // login code
      });

      await adapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      expect(store.save).toHaveBeenCalledWith("default", "saved-session-xyz");
    });

    it("displays connected username on success", async () => {
      const client = makeMockClient({ username: "alice", userId: 42 });
      const store = makeMockSessionStore();
      const createClient: CreateClientFn = vi.fn(() => client);
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient,
        sessionStore: store,
      });

      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("12345678")
          .mockResolvedValueOnce("0123456789abcdef")
          .mockResolvedValueOnce("+15551234567")
          .mockResolvedValueOnce("12345"),
      });

      await adapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      // Find the note call with "Connected as"
      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      const successNote = noteCalls.find(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("Connected as"),
      );
      expect(successNote).toBeDefined();
      expect(successNote![0]).toContain("@alice");
      expect(successNote![0]).toContain("42");
    });

    it("handles auth failure gracefully and still saves config", async () => {
      const client = makeMockClient({
        connectError: new Error("PHONE_CODE_INVALID"),
      });
      const store = makeMockSessionStore();
      const createClient: CreateClientFn = vi.fn(() => client);
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient,
        sessionStore: store,
      });

      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("12345678")
          .mockResolvedValueOnce("0123456789abcdef")
          .mockResolvedValueOnce("+15551234567")
          .mockResolvedValueOnce("wrong-code"),
      });

      const result = await adapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      // Config should still have API credentials saved
      const section = result.cfg.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.apiId).toBe(12345678);
      expect(section.apiHash).toBe("0123456789abcdef");
      // Session should NOT have been saved
      expect(store.save).not.toHaveBeenCalled();
      // Error note should have been shown
      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      const errorNote = noteCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("Authentication failed"),
      );
      expect(errorNote).toBeDefined();
    });

    it("keeps existing session when user confirms", async () => {
      const store = makeMockSessionStore();
      await store.save("default", "existing-session");
      const createClient: CreateClientFn = vi.fn();
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient,
        sessionStore: store,
      });

      const prompter = makePrompter({
        confirm: vi.fn().mockResolvedValue(true), // keep session
      });

      const result = await adapter.configure({
        cfg: makeCfg({ apiId: 12345, apiHash: "0123456789abcdef" }),
        prompter,
        ...defaults,
      });

      // Should NOT have created a new client since we kept the session
      expect(createClient).not.toHaveBeenCalled();
      const section = result.cfg.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.enabled).toBe(true);
      expect(result.accountId).toBe("default");
    });

    it("preserves existing config when adding credentials", async () => {
      const client = makeMockClient();
      const store = makeMockSessionStore();
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient: () => client,
        sessionStore: store,
      });

      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("99999")
          .mockResolvedValueOnce("newhash123abcdefgh")
          .mockResolvedValueOnce("+15551234567")
          .mockResolvedValueOnce("12345"),
      });

      const result = await adapter.configure({
        cfg: makeCfg({ allowFrom: [111, 222], someOtherProp: "keep" }),
        prompter,
        ...defaults,
      });

      const section = result.cfg.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.apiId).toBe(99999);
      expect(section.apiHash).toBe("newhash123abcdefgh");
      expect(section.allowFrom).toEqual([111, 222]);
      expect(section.someOtherProp).toBe("keep");
    });

    it("returns accountId in result", async () => {
      const client = makeMockClient();
      const store = makeMockSessionStore();
      const adapter = buildTelegramUserbotOnboardingAdapter({
        createClient: () => client,
        sessionStore: store,
      });

      const prompter = makePrompter({
        text: vi
          .fn()
          .mockResolvedValueOnce("12345")
          .mockResolvedValueOnce("abc123hash0123456789")
          .mockResolvedValueOnce("+15551234567")
          .mockResolvedValueOnce("12345"),
      });

      const result = await adapter.configure({
        cfg: makeCfg(),
        prompter,
        ...defaults,
      });

      expect(result.accountId).toBe("default");
    });
  });

  describe("disable", () => {
    it("sets enabled to false while preserving credentials", () => {
      const adapter = buildTelegramUserbotOnboardingAdapter();
      const result = adapter.disable!(makeCfg({ apiId: 12345, apiHash: "hash", enabled: true }));
      const section = result.channels?.["telegram-userbot"] as Record<string, unknown>;
      expect(section.enabled).toBe(false);
      expect(section.apiId).toBe(12345);
      expect(section.apiHash).toBe("hash");
    });
  });

  describe("adapter shape", () => {
    it("has required adapter fields", () => {
      const adapter = buildTelegramUserbotOnboardingAdapter();
      expect(adapter.channel).toBe("telegram-userbot");
      expect(adapter.getStatus).toBeTypeOf("function");
      expect(adapter.configure).toBeTypeOf("function");
      expect(adapter.disable).toBeTypeOf("function");
      expect(adapter.dmPolicy).toBeDefined();
      expect(adapter.dmPolicy!.channel).toBe("telegram-userbot");
      expect(adapter.dmPolicy!.label).toBe("Telegram Userbot");
      expect(adapter.dmPolicy!.getCurrent).toBeTypeOf("function");
      expect(adapter.dmPolicy!.setPolicy).toBeTypeOf("function");
      expect(adapter.dmPolicy!.promptAllowFrom).toBeTypeOf("function");
    });
  });
});
