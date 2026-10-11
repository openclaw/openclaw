import fs from "node:fs";
import path from "node:path";
import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import { resolveMSTeamsAccount } from "./accounts.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { collectMSTeamsSecurityWarnings } from "./channel-config.js";
import { msteamsPlugin } from "./channel.js";
import { msteamsSetupPlugin } from "./channel.setup.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";

const probeMSTeamsMock = vi.hoisted(() => vi.fn());
const monitorMSTeamsProviderMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorMSTeamsProvider: monitorMSTeamsProviderMock,
}));

vi.mock("./channel.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel.runtime.js")>();
  return {
    ...actual,
    msTeamsChannelRuntime: {
      ...actual.msTeamsChannelRuntime,
      probeMSTeams: probeMSTeamsMock,
    },
  };
});

function createConfiguredMSTeamsCfg(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "secret",
        tenantId: "tenant-id",
      },
    },
  };
}

describe("msteamsPlugin.security.collectWarnings", () => {
  it("records an intentional open groupPolicy as a non-blocking posture advisory", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "open",
        },
      },
    } satisfies OpenClawConfig;
    const account = msteamsPlugin.config.resolveAccount(cfg, "default");

    expect(await msteamsPlugin.security?.collectWarnings?.({ cfg, account })).toEqual([
      {
        checkId: "channels.msteams.groups.open",
        severity: "warn",
        title: "MS Teams security warning",
        detail:
          'MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.',
      },
    ]);
  });
});

describe("msteamsPlugin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["teams", "msteams"])(
    "recognizes %s-prefixed user IDs without claiming display names",
    (provider) => {
      const messaging = msteamsPlugin.messaging;
      const aadUserId = "40a1a0ed-4ff2-4164-a219-55518990c197";
      const target = `${provider}:user:${aadUserId}`;

      expect(messaging?.targetResolver?.looksLikeId?.(target)).toBe(true);
      expect(messaging?.normalizeTarget?.(target)).toBe(`user:${aadUserId}`);
      expect(messaging?.targetResolver?.looksLikeId?.(`${provider}:user:Jane Doe`)).toBe(false);
    },
  );

  it.each([
    { webhookPath: "", info: "18789/api/messages", warning: undefined },
    { webhookPath: "/ready", info: undefined, warning: "reserved for Gateway checks" },
  ])(
    "classifies Doctor webhook guidance for $webhookPath",
    async ({ webhookPath, info, warning }) => {
      const cfg: OpenClawConfig = { channels: { msteams: { webhook: { path: webhookPath } } } };
      const result = await msteamsPlugin.doctor?.runConfigSequence?.({
        cfg,
        env: {},
        shouldRepair: false,
      });
      expect(result?.changeNotes).toEqual([]);
      expect(result?.infoNotes ?? []).toEqual(info ? [expect.stringContaining(info)] : []);
      expect(result?.warningNotes).toEqual(warning ? [expect.stringContaining(warning)] : []);
    },
  );

  it("reports each enabled Doctor route with the authored recovery and compatibility paths", async () => {
    const support = {
      appId: "support-app",
      webhook: { path: "/healthz" },
      legacyWebhook: { port: 3979 },
    };
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          legacyWebhook: { port: 3978 },
          accounts: {
            Default: { appId: "default-app", webhook: { path: "/api/default" } },
            "Support Team": support,
            sibling: { appId: "sibling-app" },
            disabled: { enabled: false, webhook: { path: "/ready" } },
          },
        },
      },
    };
    const result = await msteamsPlugin.doctor?.runConfigSequence?.({
      cfg,
      env: {},
      shouldRepair: false,
    });
    expect(result?.changeNotes).toEqual([]);
    expect(result?.warningNotes).toEqual([
      expect.stringContaining(
        "Set channels.msteams.accounts.Support Team.webhook.path to /api/messages/support-team",
      ),
    ]);
    expect(result?.warningNotes?.[0]).toContain(
      "before removing channels.msteams.accounts.Support Team.legacyWebhook",
    );
    expect(result?.infoNotes).toEqual([
      expect.stringContaining("remove the channels.msteams.legacyWebhook pin"),
      expect.stringContaining(
        "Microsoft Teams (sibling) webhooks use Gateway port 18789/api/messages/sibling; no compatibility listener",
      ),
    ]);
    support.webhook.path = "/api/messages/support-team";
    const repaired = await msteamsPlugin.doctor?.runConfigSequence?.({
      cfg,
      env: {},
      shouldRepair: false,
    });
    expect(repaired?.warningNotes).toEqual([]);
    expect(repaired?.infoNotes).toContainEqual(
      expect.stringContaining("Gateway port 18789/api/messages/support-team"),
    );
  });

  it("preserves the default account and allowlist across runtime and setup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          allowFrom: ["OWNER", "  Team.Member  "],
          defaultTo: "19:team@thread.tacv2",
        },
      },
    };

    for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
      expect(plugin.config.defaultAccountId?.(cfg)).toBe("default");
      expect(plugin.config.resolveAccount(cfg, "default")).toMatchObject({
        accountId: "default",
        enabled: true,
        configured: true,
        tokenStatus: "available",
      });
      expect(plugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
        "OWNER",
        "  Team.Member  ",
      ]);
      expect(
        plugin.config.formatAllowFrom?.({
          cfg,
          accountId: "default",
          allowFrom: ["OWNER", "  Team.Member  "],
        }),
      ).toEqual(["owner", "team.member"]);
      expect(plugin.config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
        "19:team@thread.tacv2",
      );
    }
  });

  it.each([
    {
      label: "configured certificate",
      configuredPath: "/private/msteams-unavailable-configured.pem",
      envPath: undefined,
      diagnosticPath: "channels.msteams.certificatePath",
    },
    {
      label: "environment certificate",
      configuredPath: "   ",
      envPath: "/private/msteams-unavailable-env.pem",
      diagnosticPath: "env.MSTEAMS_CERTIFICATE_PATH",
    },
  ])("degrades an unavailable $label without exposing its filesystem path", async (selection) => {
    await withTempDir("msteams-certificate-precedence-", async (tempDir) => {
      const fallback = path.join(tempDir, "env-cert.pem");
      fs.writeFileSync(fallback, "available-certificate", "utf8");
      vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", fallback);
      if (selection.envPath) {
        vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", selection.envPath);
      }
      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            appId: "app-id",
            tenantId: "tenant-id",
            authType: "federated",
            certificatePath: selection.configuredPath,
          },
        },
      };

      for (const plugin of [msteamsPlugin, msteamsSetupPlugin]) {
        const account = plugin.config.resolveAccount(cfg, "default");
        expect(account).toMatchObject({
          configured: true,
          tokenStatus: "configured_unavailable",
          credentialDiagnostics: [
            {
              code: "CREDENTIAL_FILE_UNAVAILABLE",
              path: selection.diagnosticPath,
              reason: "not-found",
            },
          ],
        });
        expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(
          selection.envPath ?? selection.configuredPath,
        );
        expect(plugin.config.isConfigured?.(account, cfg)).toBe(true);
        expect(plugin.config.describeAccount?.(account, cfg)).toMatchObject({
          configured: true,
          tokenStatus: "configured_unavailable",
        });
      }

      expect(msteamsPlugin.actions?.describeMessageTool?.({ cfg })).toEqual({
        actions: [],
        capabilities: [],
        schema: null,
      });

      const account = msteamsPlugin.config.resolveAccount(cfg, "default");
      expect(await msteamsPlugin.status?.buildAccountSnapshot?.({ account, cfg })).toMatchObject({
        configured: true,
        tokenStatus: "configured_unavailable",
      });
    });
  });

  it("does not inspect an unavailable certificate when managed identity is selected", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "app-id",
          tenantId: "tenant-id",
          authType: "federated",
          certificatePath: "/private/msteams-unused-missing-certificate.pem",
          useManagedIdentity: true,
        },
      },
    };

    expect(msteamsPlugin.actions?.describeMessageTool?.({ cfg })?.actions).toContain("upload-file");
    expect(msteamsPlugin.config.resolveAccount(cfg, "default")).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
      tokenStatus: "available",
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves the existing symlink-friendly certificate file policy",
    async () => {
      await withTempDir("msteams-certificate-symlink-", async (tempDir) => {
        const certificate = path.join(tempDir, "certificate.pem");
        const symlink = path.join(tempDir, "certificate-link.pem");
        fs.writeFileSync(certificate, "available-certificate", "utf8");
        fs.symlinkSync(certificate, symlink);
        const cfg: OpenClawConfig = {
          channels: {
            msteams: {
              appId: "app-id",
              tenantId: "tenant-id",
              authType: "federated",
              certificatePath: symlink,
            },
          },
        };

        expect(msteamsPlugin.config.resolveAccount(cfg, "default")).toMatchObject({
          configured: true,
          tokenStatus: "available",
        });
      });
    },
  );

  it("registers the approval runtime before monitor startup only when native delivery is enabled", async () => {
    const monitor = monitorMSTeamsProviderMock.mockReset().mockResolvedValue({
      app: null,
      shutdown: async () => {},
    });
    const register = vi.fn(() => ({ dispose: vi.fn() }));
    const controller = new AbortController();
    const cfg: OpenClawConfig = {
      ...createConfiguredMSTeamsCfg(),
      approvals: { exec: { enabled: true } },
      channels: {
        msteams: {
          ...createConfiguredMSTeamsCfg().channels?.msteams,
          allowFrom: ["40a1a0ed-4ff2-4164-a219-55518990c197"],
        },
      },
    };
    const startAccount = async (config: OpenClawConfig) =>
      await msteamsPlugin.gateway?.startAccount?.({
        cfg: config,
        accountId: "default",
        account: msteamsPlugin.config.resolveAccount(config, "default"),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        abortSignal: controller.signal,
        getStatus: () => ({ accountId: "default" }),
        setStatus: vi.fn(),
        channelRuntime: {
          runtimeContexts: {
            register,
            get: () => undefined,
            watch: () => () => {},
          },
        },
      });

    try {
      await startAccount(cfg);

      expect(register).toHaveBeenCalledWith({
        channelId: "msteams",
        accountId: "default",
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {},
        abortSignal: controller.signal,
      });
      expect(register.mock.invocationCallOrder[0]).toBeLessThan(
        monitor.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );

      await startAccount({ ...cfg, approvals: { exec: { enabled: false } } });

      expect(register).toHaveBeenCalledOnce();
      expect(monitor).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      monitor.mockReset();
    }
  });
});

describe("msteamsPlugin.approvalCapability", () => {
  const ownerId = "123e4567-e89b-12d3-a456-426614174000";
  const otherUserId = "22222222-2222-4222-8222-222222222222";

  function authorizeApproval(
    allowFrom: string[],
    senderId: string,
    approvalKind: "exec" | "plugin" | "system-agent" = "exec",
  ) {
    return msteamsPlugin.approvalCapability?.authorizeActorAction?.({
      cfg: { channels: { msteams: { allowFrom } } },
      senderId,
      action: "approve",
      approvalKind,
    });
  }

  it.each(["exec", "plugin", "system-agent"] as const)(
    "authorizes only the configured owner for %s after normalizing an AAD principal",
    (approvalKind) => {
      const allowFrom = [`MSTEAMS:USER:${ownerId.toUpperCase()}`];
      expect(authorizeApproval(allowFrom, ownerId, approvalKind)).toEqual({ authorized: true });
      expect(authorizeApproval(allowFrom, otherUserId, approvalKind)).toMatchObject({
        authorized: false,
      });
    },
  );

  it("preserves implicit same-chat authorization when no approvers are configured", () => {
    const result = authorizeApproval([], ownerId);
    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(true);
  });

  it("does not authorize a conversation id as an approval principal", () => {
    expect(
      authorizeApproval([ownerId, `msteams:conversation:${otherUserId}`], otherUserId),
    ).toMatchObject({ authorized: false });
  });
});

const conversation = "conversation:19:current@thread.tacv2";
const graphChannel = "19:channel@thread.tacv2";
const graphTarget = `11111111-1111-1111-1111-111111111111/${graphChannel}`;
const buildContext = msteamsPlugin.threading!.buildToolContext!;
const extract = msteamsPlugin.actions!.extractToolSendResult!;
const autoThread = msteamsPlugin.threading!.resolveAutoThreadId!;
describe("Teams delivery reconciliation", () => {
  it.each([
    { conversationId: "19:channel@thread.tacv2" },
    { receipt: { raw: [{ conversationId: "19:channel@thread.tacv2" }] } },
    { receipt: { parts: [{ raw: { conversationId: "19:channel@thread.tacv2" } }] } },
  ])("recovers the authoritative conversation from %j", (result) => {
    expect(
      extract({ result: { details: { result } }, send: { to: graphTarget, threadId: "root" } }),
    ).toEqual({ to: "conversation:19:channel@thread.tacv2" });
  });

  it.each([
    undefined,
    { details: { result: {} } },
    { details: { result: { receipt: { raw: [{}] } } } },
  ])("rejects a result without an authoritative conversation: %j", (result) => {
    expect(extract({ result, send: { to: graphTarget, threadId: "root" } })).toBeNull();
  });
});

describe("Teams automatic threading", () => {
  const context = {
    currentChannelId: conversation,
    currentThreadTs: "thread-root",
    replyToMode: "all" as const,
  };
  it("uses the inbound thread root instead of its quoted parent", () => {
    const toolContext = buildContext({
      cfg: {},
      context: {
        ChatType: "channel",
        To: conversation,
        MessageThreadId: "thread-root",
        ReplyToId: "parent",
      },
    });
    expect(autoThread({ cfg: {}, to: conversation, toolContext })).toBe("thread-root");
  });

  it("uses top-level replies when mention gating is disabled", () => {
    expect(
      autoThread({
        cfg: { channels: { msteams: { requireMention: false } } },
        to: conversation,
        toolContext: context,
      }),
    ).toBeUndefined();
  });

  it("honors channel overrides over team and global reply styles", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          replyStyle: "thread",
          teams: {
            "team-1": {
              replyStyle: "top-level",
              channels: { [graphChannel]: { replyStyle: "thread" } },
            },
          },
        },
      },
    };
    expect(
      autoThread({
        cfg,
        to: conversation,
        toolContext: { ...context, currentGraphChannelId: "team-1/19:other@thread.tacv2" },
      }),
    ).toBeUndefined();
    expect(
      autoThread({
        cfg,
        to: conversation,
        toolContext: { ...context, currentGraphChannelId: `team-1/${graphChannel}` },
      }),
    ).toBe("thread-root");
  });

  it("preserves an explicit thread under top-level reply style", () => {
    expect(
      autoThread({
        cfg: { channels: { msteams: { replyStyle: "top-level" } } },
        to: `${conversation};messageid=explicit-root`,
        toolContext: context,
      }),
    ).toBe("explicit-root");
  });

  it("does not borrow a thread from a different conversation", () => {
    expect(
      autoThread({ cfg: {}, to: "conversation:19:other@thread.tacv2", toolContext: context }),
    ).toBeUndefined();
  });

  it("does not invent a thread for a DM", () => {
    expect(
      autoThread({
        cfg: {},
        to: "user:aad-user-1",
        toolContext: { currentChannelId: "user:aad-user-1" },
      }),
    ).toBeUndefined();
  });
});

const msteamsDirectoryAdapter = msteamsPlugin.directory;

function requireDirectorySelf(): NonNullable<NonNullable<typeof msteamsDirectoryAdapter>["self"]> {
  const directorySelf = msteamsDirectoryAdapter?.self;
  if (!directorySelf) {
    throw new Error("expected msteams directory.self");
  }
  return directorySelf;
}

describe("msteams directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() satisfies RuntimeEnv;
  const directorySelf = requireDirectorySelf();

  afterEach(() => {
    probeMSTeamsMock.mockReset();
    monitorMSTeamsProviderMock.mockReset();
    vi.unstubAllEnvs();
  });

  describe("self()", () => {
    it("returns bot identity when credentials are configured", async () => {
      const cfg = {
        channels: {
          msteams: {
            appId: "test-app-id-1234",
            appPassword: "secret",
            tenantId: "tenant-id-5678",
          },
        },
      } satisfies OpenClawConfig;

      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toEqual({ kind: "user", id: "test-app-id-1234", name: "test-app-id-1234" });
    });

    it("returns null when credentials are not configured", async () => {
      vi.stubEnv("MSTEAMS_APP_ID", "");
      vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
      vi.stubEnv("MSTEAMS_TENANT_ID", "");
      const cfg = { channels: {} } satisfies OpenClawConfig;
      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toBeNull();
    });
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: [" alice ", " user:Bob "],
          dms: { " carol ": {}, "user:bob": {} },
          teams: {
            team1: {
              channels: {
                "conversation:chan1": {},
                chan2: {},
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const directory = expectDirectorySurface(msteamsDirectoryAdapter);

    const peers = await directory.listPeers({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "user:alice" },
      { kind: "user", id: "user:Bob" },
      { kind: "user", id: "user:carol" },
      { kind: "user", id: "user:bob" },
    ]);

    const groups = await directory.listGroups({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(groups).toStrictEqual([
      { kind: "group", id: "conversation:chan1" },
      { kind: "group", id: "conversation:chan2" },
    ]);
  });
});

describe("msteams session route", () => {
  it("builds direct routes for explicit user targets", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:01234567-89ab-cdef-0123-456789abcdef",
    });

    expect(route?.peer).toEqual({
      kind: "direct",
      id: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(route?.from).toBe("msteams:01234567-89ab-cdef-0123-456789abcdef");
    expect(route?.to).toBe("user:01234567-89ab-cdef-0123-456789abcdef");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim display-name user targets as canonical sessions", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:user:Alice Example",
      resolvedTarget: { to: "user:Alice Example", kind: "user", source: "directory" },
    });

    expect(route?.recipientSessionExact).toBe(false);
  });

  it("builds channel routes for thread conversations and strips suffix metadata", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2;messageid=42",
    });

    expect(route?.peer).toEqual({ kind: "channel", id: "19:abc123@thread.tacv2" });
    expect(route?.from).toBe("msteams:channel:19:abc123@thread.tacv2");
    expect(route?.to).toBe("conversation:19:abc123@thread.tacv2");
    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2:thread:42");
    expect(route?.threadId).toBe("42");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim an exact channel session without its thread root", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2",
    });

    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2");
    expect(route?.recipientSessionExact).toBe(false);
  });

  it("returns group routes for non-user, non-channel conversations", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:conversation:19:groupchat",
    });

    expect(route?.peer).toEqual({ kind: "group", id: "19:groupchat" });
    expect(route?.from).toBe("msteams:group:19:groupchat");
    expect(route?.to).toBe("conversation:19:groupchat");
    expect(route?.recipientSessionExact).toBe(false);
  });

  it("returns null when the target cannot be normalized", () => {
    expect(
      resolveMSTeamsOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: "msteams:",
      }),
    ).toBeNull();
  });
});

describe("Teams named-account integration", () => {
  afterEach(() => {
    probeMSTeamsMock.mockReset();
    monitorMSTeamsProviderMock.mockReset();
    vi.unstubAllEnvs();
  });
  it("does not resolve named-account SecretRefs while collecting group-policy warnings", () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: {
                source: "env",
                provider: "default",
                id: "SUPPORT_MSTEAMS_SECRET",
              },
              groupPolicy: "open",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(collectMSTeamsSecurityWarnings({ cfg, accountId: "support" })).toEqual([
      '- MS Teams[support] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.accounts.support.groupPolicy="allowlist" + channels.msteams.accounts.support.groupAllowFrom to restrict senders.',
    ]);
  });

  it("reports unavailable named-account certificates without default-account fallback", () => {
    vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", "/private/msteams-default-env.pem");
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              authType: "federated",
              certificatePath: "/private/msteams-support-missing.pem",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const account = msteamsPlugin.config.resolveAccount(cfg, "support");
    expect(account).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "configured_unavailable",
      credentialDiagnostics: [
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.msteams.accounts.support.certificatePath",
          reason: "not-found",
        },
      ],
    });
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(
      "/private/msteams-support-missing.pem",
    );
    expect(
      msteamsPlugin.actions?.describeMessageTool?.({ cfg, accountId: "support" })?.actions,
    ).toEqual([]);
  });

  it("uses account-scoped Teams credentials for message-tool discovery", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "default",
      })?.actions,
    ).toEqual([]);
    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "support",
      })?.actions,
    ).toContain("upload-file");
  });

  it("probes the resolved named account config", async () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const account = msteamsPlugin.config.resolveAccount(cfg, "support");
    probeMSTeamsMock.mockResolvedValueOnce({ ok: true, appId: "support-app-id" });

    await msteamsPlugin.status?.probeAccount?.({ cfg, account, timeoutMs: 1_000 });

    expect(probeMSTeamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "tenant-id",
        webhook: { path: "/hooks/3979" },
      }),
      { accountId: "support" },
    );
  });

  it("evaluates group-policy warnings for the requested account", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              tenantId: "tenant-id",
              groupPolicy: "open",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const account = msteamsPlugin.config.resolveAccount(cfg, "support");

    const findings = await msteamsPlugin.security?.collectWarnings?.({
      cfg,
      accountId: "support",
      account,
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "channels.msteams.groups.open",
        severity: "warn",
        title: "MS Teams security warning",
        detail: expect.stringMatching(
          /MS Teams\[support\].*channels\.msteams\.accounts\.support\.groupPolicy.*channels\.msteams\.accounts\.support\.groupAllowFrom/,
        ),
      }),
    ]);
    expect(
      await msteamsPlugin.security?.collectWarnings?.({
        cfg,
        accountId: "default",
        account: msteamsPlugin.config.resolveAccount(cfg, "default"),
      }),
    ).toEqual([]);

    const defaultOverrideCfg = {
      channels: {
        msteams: {
          accounts: {
            Default: {
              appId: "default-app-id",
              appPassword: "default-secret",
              tenantId: "tenant-id",
              groupPolicy: "open",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const defaultFindings = await msteamsPlugin.security?.collectWarnings?.({
      cfg: defaultOverrideCfg,
      accountId: "default",
      account: msteamsPlugin.config.resolveAccount(defaultOverrideCfg, "default"),
    });
    expect(defaultFindings).toEqual([
      expect.objectContaining({
        detail: expect.stringMatching(
          /channels\.msteams\.accounts\.Default\.groupPolicy.*channels\.msteams\.accounts\.Default\.groupAllowFrom/,
        ),
      }),
    ]);
  });

  it("does not advertise message tools for disabled or unconfigured named accounts", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-app-id");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-secret");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant-id");
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            disabled: {
              enabled: false,
              appId: "disabled-app-id",
              appPassword: "disabled-secret",
              webhook: { path: "/hooks/3979" },
            },
            unconfigured: {
              appId: "unconfigured-app-id",
              webhook: { path: "/hooks/3980" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "disabled",
      })?.actions,
    ).toEqual([]);
    expect(
      msteamsPlugin.actions?.describeMessageTool?.({
        cfg,
        accountId: "unconfigured",
      })?.actions,
    ).toEqual([]);
  });
  it("starts display-style account ids under their canonical runtime identity", async () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          accounts: {
            "Support Bot": {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const setStatus = vi.fn();
    monitorMSTeamsProviderMock.mockImplementationOnce(
      async (params: Parameters<typeof import("./monitor.js").monitorMSTeamsProvider>[0]) => {
        params.statusSink?.({ running: true });
        return { app: null, shutdown: async () => {} };
      },
    );

    await msteamsPlugin.gateway?.startAccount?.({
      cfg,
      accountId: "Support Bot",
      account: resolveMSTeamsAccount({ cfg, accountId: "Support Bot" }),
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code): never => {
          throw new Error(String(code));
        },
      },
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: "Support Bot" }),
      setStatus,
    });

    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ accountId: "support-bot" }));
    expect(monitorMSTeamsProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "support-bot",
        msteamsCfg: expect.objectContaining({
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        }),
      }),
    );
  });

  it("uses account-scoped approvers for named Teams accounts", () => {
    const rootApprover = "123e4567-e89b-12d3-a456-426614174000";
    const supportApprover = "223e4567-e89b-12d3-a456-426614174000";
    const cfg = {
      channels: {
        msteams: {
          allowFrom: [`user:${rootApprover}`],
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              allowFrom: [`user:${supportApprover}`],
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg,
        accountId: "support",
        senderId: supportApprover,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        cfg,
        accountId: "support",
        senderId: rootApprover,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Microsoft Teams.",
    });
  });
});
