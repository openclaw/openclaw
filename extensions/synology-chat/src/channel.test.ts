// Synology Chat tests cover channel plugin behavior.
import { createPluginSetupWizardStatus } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSynologyChatAccount, SynologyChatChannelConfig } from "./types.js";

const securityAccountDefaults: ResolvedSynologyChatAccount = {
  accountId: "default",
  enabled: true,
  token: "t",
  incomingUrl: "https://nas/incoming",
  webhookUrl: "https://gateway.example.com/w",
  nasHost: "h",
  webhookPath: "/w",
  webhookPathSource: "default" as const,
  dangerouslyAllowNameMatching: false,
  dangerouslyAllowInheritedWebhookPath: false,
  dmPolicy: "allowlist" as const,
  allowedUserIds: [],
  rateLimitPerMinute: 30,
  botName: "Bot",
  allowInsecureSsl: false,
};

const { preparedCapabilityUrl, prepareSynologyHostedMediaMock } = vi.hoisted(() => ({
  preparedCapabilityUrl:
    "https://gateway.example.com/w?__openclaw_synology_media_token_aaaaaaaaaaaaaaaaaaaaaaaa=secret",
  prepareSynologyHostedMediaMock: vi.fn(),
}));

vi.mock("./outbound-media.js", () => ({
  prepareSynologyHostedMedia: prepareSynologyHostedMediaMock,
  resolveSynologyHostedMediaRoute: vi.fn(() => ({
    localRoutePath: "/w/",
    publicBaseUrl: "https://gateway.example.com",
    publicRoutePath: "/w",
    publicSearch: "",
  })),
  tryHandleSynologyHostedMediaRequest: vi.fn(async () => false),
}));

function makeSecurityAccount(
  overrides: Partial<ResolvedSynologyChatAccount> = {},
): ResolvedSynologyChatAccount {
  return { ...securityAccountDefaults, ...overrides };
}

function expectIncludesSubstring(values: unknown[], text: string, severity?: string): void {
  expect(JSON.stringify(values)).toContain(text);
  if (severity) {
    expect(values).toContainEqual(expect.objectContaining({ severity }));
  }
}

function collectWarnings(overrides: Partial<ResolvedSynologyChatAccount>) {
  return plugin.security.collectWarnings({
    cfg: {},
    account: makeSecurityAccount(overrides),
  });
}

function mockStringMessages(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => {
    const message = call[0];
    return typeof message === "string" ? message : "";
  });
}

const clientModule = await import("./client.js");
const gatewayRuntimeModule = await import("./gateway-runtime.js");
const mockSendMessage = vi.spyOn(clientModule, "sendMessage").mockResolvedValue({ messageIds: [] });
const mockSendHostedFileUrl = vi
  .spyOn(clientModule, "sendHostedFileUrl")
  .mockResolvedValue({ status: "accepted" });
const registerSynologyWebhookRouteMock = vi
  .spyOn(gatewayRuntimeModule, "registerSynologyWebhookRoute")
  .mockImplementation(async () => vi.fn(async () => undefined));

vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: vi.fn(() => vi.fn()),
}));

const { synologyChatPlugin: plugin } = await import("./channel.js");
const getSynologyChatSetupStatus = createPluginSetupWizardStatus(plugin);

const PAIRING_CFG = {
  channels: {
    "synology-chat": {
      token: "default-token",
      incomingUrl: "https://nas-default/incoming",
      webhookUrl: "https://gateway.example.com/w",
      allowInsecureSsl: false,
      accounts: {
        beta: {
          token: "beta-token",
          incomingUrl: "https://nas-beta/incoming",
          webhookUrl: "https://gateway.example.com/beta",
          allowInsecureSsl: true,
        },
      },
    },
  },
};

describe("synology chat target classification", () => {
  it("accepts numeric chat user ids as direct", () => {
    expect(plugin.messaging?.inferTargetChatType?.({ to: "42" })).toBe("direct");
    expect(plugin.messaging?.inferTargetChatType?.({ to: "room" })).toBeUndefined();
  });
});

describe("createSynologyChatPlugin", () => {
  beforeEach(() => {
    vi.stubEnv("SYNOLOGY_CHAT_TOKEN", "");
    vi.stubEnv("SYNOLOGY_CHAT_INCOMING_URL", "");
    mockSendMessage.mockClear();
    mockSendHostedFileUrl.mockClear();
    prepareSynologyHostedMediaMock.mockReset();
    registerSynologyWebhookRouteMock.mockClear();
    mockSendMessage.mockResolvedValue({ messageIds: [] });
    mockSendHostedFileUrl.mockResolvedValue({ status: "accepted" });
    prepareSynologyHostedMediaMock.mockImplementation(async ({ account }) => {
      if (!account.webhookUrl) {
        throw new Error("Synology Chat attachments require webhookUrl");
      }
      return { url: preparedCapabilityUrl, cleanup: vi.fn(async () => undefined) };
    });
    registerSynologyWebhookRouteMock.mockImplementation(async () => vi.fn(async () => undefined));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("messaging", () => {
    it("isolates stable Chat API recipients from inbound webhook identities", () => {
      const route = plugin.messaging.resolveOutboundSessionRoute({
        cfg: {},
        agentId: "ops",
        accountId: "work",
        target: "synology-chat:42",
      });

      expect(route).toEqual({
        sessionKey: "agent:ops:synology-chat:work:direct:chat-api-42",
        baseSessionKey: "agent:ops:synology-chat:work:direct:chat-api-42",
        recipientSessionExact: "delivery-identity",
        peer: { kind: "direct", id: "chat-api-42" },
        chatType: "direct",
        from: "synology-chat:chat-api:42",
        to: "42",
      });
    });

    it("rejects non-numeric Chat API recipients for session routing", () => {
      const route = plugin.messaging.resolveOutboundSessionRoute({
        cfg: {},
        agentId: "ops",
        target: "synology-chat:alice",
      });

      expect(route).toBeNull();
    });

    it("canonicalizes safe Chat API recipient IDs", () => {
      const route = plugin.messaging.resolveOutboundSessionRoute({
        cfg: {},
        agentId: "ops",
        target: "synology_chat:+00042",
      });

      expect(route).toMatchObject({
        sessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
        peer: { kind: "direct", id: "chat-api-42" },
        to: "42",
      });
    });
  });

  it("projects lifecycle through the computed status adapter", async () => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "test-token",
          incomingUrl: "https://nas/incoming",
          webhookUrl: "https://gateway.example.com/webhook/synology?proxy-token=redacted",
        },
      },
    };
    const account = plugin.config.resolveAccount(cfg, "default");

    const snapshot = await plugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: { accountId: "default", lifecycle: "ready" },
    });

    expect(snapshot).toMatchObject({
      accountId: "default",
      configured: true,
      lifecycle: "ready",
      webhookPath: "/webhook/synology",
      attachmentsReady: true,
    });
    expect(snapshot).not.toHaveProperty("webhookUrl");
  });

  it.each([
    "https://gateway.example.com/webhook/synology#fragment",
    "https://gateway.example.com/webhook/synology?__openclaw_synology_media_token_fixture=value",
  ])("reports attachments unready when webhookUrl is invalid: %s", async (webhookUrl) => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "test-token",
          incomingUrl: "https://nas/incoming",
          webhookUrl,
        },
      },
    };
    const account = plugin.config.resolveAccount(cfg, "default");

    const snapshot = await plugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: { accountId: "default", lifecycle: "ready" },
    });

    expect(snapshot).toMatchObject({ configured: true, attachmentsReady: false });
  });

  describe("config", () => {
    it("setup status honors the selected named account", async () => {
      const status = await getSynologyChatSetupStatus({
        cfg: {
          channels: {
            "synology-chat": {
              accounts: {
                ops: {
                  token: "ops-token",
                  incomingUrl: "https://nas/ops",
                },
                work: {
                  token: "work-token",
                },
              },
            },
          },
        },
        accountOverrides: {
          "synology-chat": "work",
        },
      });

      expect(status.configured).toBe(false);
      expect(status.statusLines).toEqual([
        "Synology Chat: needs token + incoming webhook",
        "Accounts: 2",
      ]);
    });

    it("formats allowFrom entries through the shared adapter", () => {
      expect(
        plugin.config.formatAllowFrom?.({
          cfg: {},
          allowFrom: ["  USER1  ", 42],
        }),
      ).toEqual(["user1", "42"]);
    });
  });

  describe("security", () => {
    it("resolveDmPolicy returns policy, allowFrom, normalizeEntry", () => {
      const account = makeSecurityAccount({ allowedUserIds: ["user1"], allowInsecureSsl: true });
      const result = plugin.security.resolveDmPolicy({ cfg: {}, account });
      if (!result) {
        throw new Error("resolveDmPolicy returned null");
      }
      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual(["user1"]);
      expect(result.normalizeEntry?.("  USER1  ")).toBe("user1");
    });
  });

  describe("security.collectWarnings", () => {
    function makeSharedWebhookConfig(alertsOverrides: Record<string, unknown> = {}) {
      return {
        channels: {
          "synology-chat": {
            token: "base-token",
            webhookPath: "/webhook/shared",
            webhookUrl: "https://gateway.example.com/webhook/shared",
            accounts: {
              alerts: {
                token: "alerts-token",
                incomingUrl: "https://nas/alerts",
                dmPolicy: "allowlist",
                allowedUserIds: ["123"],
                ...alertsOverrides,
              },
            },
          },
        },
      };
    }

    it.each<{ account: Partial<ResolvedSynologyChatAccount>; text: string; severity?: string }>([
      { account: { token: "" }, text: "token" },
      { account: { allowInsecureSsl: true }, text: "SSL" },
      { account: { dangerouslyAllowNameMatching: true }, text: "dangerouslyAllowNameMatching" },
      {
        account: {
          accountId: "alerts",
          webhookPathSource: "inherited-base",
          dangerouslyAllowInheritedWebhookPath: true,
        },
        text: "dangerouslyAllowInheritedWebhookPath=true",
      },
      { account: { dmPolicy: "open", allowedUserIds: ["*"] }, text: "open", severity: "critical" },
      {
        account: { dmPolicy: "open", allowedUserIds: [] },
        text: "empty allowedUserIds",
        severity: "critical",
      },
    ])("warns about $text", ({ account, text, severity }) => {
      expectIncludesSubstring(collectWarnings(account), text, severity);
    });

    it("warns when named multi-account routes inherit a shared webhookPath", () => {
      const cfg = makeSharedWebhookConfig();
      const account = plugin.config.resolveAccount(cfg, "alerts");
      const warnings = plugin.security.collectWarnings({ cfg, account });
      expectIncludesSubstring(warnings, "must set an explicit webhookPath");
    });

    it("warns when enabled accounts share the same public webhookUrl", () => {
      const cfg = makeSharedWebhookConfig({
        webhookPath: "/webhook/alerts",
        webhookUrl: "https://gateway.example.com/synology?a=1&b=2",
      });
      cfg.channels["synology-chat"].webhookUrl = "https://gateway.example.com/synology?b=2&a=1";
      const account = plugin.config.resolveAccount(cfg, "alerts");
      const warnings = plugin.security.collectWarnings({ cfg, account });
      expectIncludesSubstring(warnings, "conflicts on webhookUrl", "critical");
    });
  });

  describe("messaging", () => {
    it("targetResolver.looksLikeId matches numeric IDs", () => {
      expect(plugin.messaging.targetResolver.looksLikeId("12345")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology-chat:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology_chat:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("notanumber")).toBe(false);
      expect(plugin.messaging.targetResolver.looksLikeId("")).toBe(false);
    });
  });

  describe("agentPrompt", () => {
    it("returns formatting hints", () => {
      const hints = plugin.agentPrompt.messageToolHints();
      expect(hints).toContain("### Synology Chat Formatting");
      expect(hints).toContain("**Links**: Use `<URL|display text>` to create clickable links.");
      expect(hints).toContain("- No buttons, cards, or interactive elements");
    });
  });

  function makeOutboundConfig(overrides: SynologyChatChannelConfig = {}) {
    return {
      channels: {
        "synology-chat": {
          enabled: true,
          token: "t",
          incomingUrl: "https://nas/incoming",
          webhookUrl: "https://gateway.example.com/w",
          ...overrides,
        },
      },
    };
  }

  function sendMedia() {
    return plugin.outbound.sendMedia({
      cfg: makeOutboundConfig(),
      mediaUrl: "https://example.com/img.png",
      to: "user1",
    });
  }

  function stageMedia() {
    const cleanup = vi.fn(async () => undefined);
    prepareSynologyHostedMediaMock.mockResolvedValueOnce({ url: preparedCapabilityUrl, cleanup });
    return cleanup;
  }

  describe("outbound", () => {
    it("sendText returns an honest empty-id result on success", async () => {
      const malformedLink = `[${"\\".repeat(32)}`;
      const result = await plugin.outbound.sendText({
        cfg: makeOutboundConfig({ webhookUrl: "", allowInsecureSsl: true }),
        text: `**Read** [the docs](https://example.com/a_(b)) [titled](https://example.com "Documentation") \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`,
        to: "user1",
      });
      expect(result.channel).toBe("synology-chat");
      expect(result.target).toEqual({ kind: "chat", id: "user1" });
      expect(result.messageId).toBe("");
      expect(result.receipt.primaryPlatformMessageId).toBeUndefined();
      expect(result.receipt.platformMessageIds).toHaveLength(0);
      expect(result.receipt.parts).toHaveLength(0);
      expect(result.receipt.threadId).toBe("user1");
      expect(mockSendMessage).toHaveBeenLastCalledWith(
        "https://nas/incoming",
        `**Read** <https://example.com/a_(b)|the docs> <https://example.com|titled> \`[literal](https://example.com)\` \\[escaped](https://example.com) [x > y](https://example.com) [bad](<https://example.com) [bad title](https://example.com "oops') ![logo](https://example.com/logo.png) ${malformedLink}`,
        "user1",
        true,
      );
    });

    it.each([
      ["indeterminate", "acceptance could not be confirmed", 0],
      ["not-dispatched", "request did not start", 1],
      ["rejected", "rejected the attachment request", 1],
    ] as const)(
      "sendMedia handles %s without losing staged-byte custody",
      async (status, error, calls) => {
        const cleanup = stageMedia();
        mockSendHostedFileUrl.mockResolvedValueOnce({ status });
        await expect(sendMedia()).rejects.toThrow(error);
        expect(cleanup).toHaveBeenCalledTimes(calls);
      },
    );

    it("sanitizeText strips internal tool-trace banners from outbound text", () => {
      const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";
      const sanitizeText = plugin.outbound.sanitizeText;
      expect(sanitizeText({ text, payload: { text } })).toBe("Done.");

      const prose = "The pipeline has 3 open deals.";
      expect(sanitizeText({ text: prose, payload: { text: prose } })).toBe(prose);
    });
  });

  describe("gateway", () => {
    function makeStartAccountCtx(
      accountConfig: Record<string, unknown>,
      abortController = new AbortController(),
    ) {
      return {
        abortController,
        ctx: {
          cfg: {
            channels: { "synology-chat": accountConfig },
          },
          accountId: "default",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          abortSignal: abortController.signal,
          setStatus: vi.fn(),
        },
      };
    }

    function makeNamedStartAccountCtx(
      accountOverrides: Record<string, unknown>,
      abortController = new AbortController(),
    ) {
      return {
        abortController,
        ctx: {
          cfg: {
            channels: {
              "synology-chat": {
                enabled: true,
                token: "default-token",
                incomingUrl: "https://nas/default",
                webhookPath: "/webhook/synology-shared",
                webhookUrl: "https://gateway.example.com/webhook/synology-default",
                dmPolicy: "allowlist",
                allowedUserIds: ["123"],
                accounts: {
                  alerts: {
                    enabled: true,
                    token: "alerts-token",
                    incomingUrl: "https://nas/alerts",
                    ...accountOverrides,
                  },
                },
              },
            },
          },
          accountId: "alerts",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          abortSignal: abortController.signal,
          setStatus: vi.fn(),
        },
      };
    }

    async function expectPendingStartAccountPromise(
      result: Promise<unknown>,
      abortController: AbortController,
    ) {
      expect(result).toBeInstanceOf(Promise);
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      abortController.abort();
      await result;
    }

    async function expectBlockedStart(
      { ctx, abortController }: ReturnType<typeof makeStartAccountCtx>,
      warning: string,
    ) {
      await expectPendingStartAccountPromise(plugin.gateway.startAccount(ctx), abortController);
      expectIncludesSubstring(mockStringMessages(ctx.log.warn), warning);
      expect(registerSynologyWebhookRouteMock).not.toHaveBeenCalled();
    }

    it("startAccount returns pending promise for disabled account", async () => {
      const { ctx, abortController } = makeStartAccountCtx({ enabled: false });
      const result = plugin.gateway.startAccount(ctx);
      await Promise.resolve();
      expect(ctx.setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "Synology Chat account failed startup validation",
      });
      await expectPendingStartAccountPromise(result, abortController);
    });

    it("publishes ready after route registration and stopped after abort cleanup", async () => {
      const cleanup = vi.fn(async () => undefined);
      registerSynologyWebhookRouteMock.mockResolvedValueOnce(cleanup);
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "allowlist",
        allowedUserIds: ["123"],
      });

      const result = plugin.gateway.startAccount(ctx);
      await vi.waitFor(() => expect(registerSynologyWebhookRouteMock).toHaveBeenCalledOnce());
      expect(ctx.setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: expect.any(Number),
        lastError: null,
        terminalDisconnect: undefined,
      });

      abortController.abort();
      await result;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(ctx.setStatus).toHaveBeenLastCalledWith({
        accountId: "default",
        running: false,
        connected: false,
        lifecycle: "stopped",
      });
    });

    it("startAccount refuses allowlist accounts with empty allowedUserIds", async () => {
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "allowlist",
        allowedUserIds: [],
      });

      await expectBlockedStart({ ctx, abortController }, "empty allowedUserIds");
    });

    it("startAccount refuses open accounts with empty allowedUserIds", async () => {
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "open",
        allowedUserIds: [],
      });

      await expectBlockedStart({ ctx, abortController }, "dmPolicy=open but empty allowedUserIds");
    });

    it("startAccount refuses named accounts without explicit webhookPath in multi-account setups", async () => {
      const { ctx, abortController } = makeNamedStartAccountCtx({
        dmPolicy: "allowlist",
        allowedUserIds: ["123"],
      });

      await expectBlockedStart({ ctx, abortController }, "must set an explicit webhookPath");
    });

    it("startAccount refuses duplicate exact webhook paths across accounts", async () => {
      const { ctx, abortController } = makeNamedStartAccountCtx({
        webhookPath: "/webhook/synology-shared",
        dmPolicy: "open",
        allowedUserIds: ["*"],
      });

      await expectBlockedStart({ ctx, abortController }, "conflicts on webhookPath");
    });

    it("startAccount refuses duplicate public webhook URLs across accounts", async () => {
      const { ctx, abortController } = makeNamedStartAccountCtx({
        webhookPath: "/webhook/synology-alerts",
        webhookUrl: "https://gateway.example.com/synology",
        dmPolicy: "open",
        allowedUserIds: ["*"],
      });
      ctx.cfg.channels["synology-chat"].webhookUrl = "https://gateway.example.com/synology";

      await expectBlockedStart({ ctx, abortController }, "conflicts on webhookUrl");
    });
  });
  describe("pairing.notifyApproval", () => {
    it("rejects a notification without a configured incoming URL", async () => {
      await expect(
        plugin.pairing.notifyApproval!({
          cfg: { channels: { "synology-chat": { accounts: { beta: { token: "beta-token" } } } } },
          id: "42",
          accountId: "beta",
        }),
      ).rejects.toThrow("incoming URL not configured");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("rejects a notification when the selected account's send fails", async () => {
      mockSendMessage.mockResolvedValue(false);
      await expect(
        plugin.pairing.notifyApproval!({
          cfg: PAIRING_CFG,
          id: "42",
          accountId: "beta",
        }),
      ).rejects.toThrow("Failed to send message to Synology Chat");
      expect(mockSendMessage).toHaveBeenCalledOnce();
    });

    it("notifies through the approved account", async () => {
      await plugin.pairing.notifyApproval!({
        cfg: PAIRING_CFG,
        id: "USER2",
        accountId: "beta",
      });
      expect(mockSendMessage).toHaveBeenCalledExactlyOnceWith(
        "https://nas-beta/incoming",
        expect.any(String),
        "USER2",
        true,
      );
    });
  });
});
