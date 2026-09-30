import fs from "node:fs";
import path from "node:path";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import { msteamsPlugin } from "./channel.js";
import { msteamsSetupPlugin } from "./channel.setup.js";

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
    } as OpenClawConfig;
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
    { webhookPath: "/ready", info: undefined, warning: "reserved for Gateway probes" },
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
      expect(plugin.config.resolveAccount(cfg, "ignored")).toEqual({
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
    expect(msteamsPlugin.config.resolveAccount(cfg, "default")).toEqual({
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
    const monitorModule = await import("./monitor.js");
    const monitor = vi.spyOn(monitorModule, "monitorMSTeamsProvider").mockResolvedValue({
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
      monitor.mockRestore();
    }
  });
});

describe("msteams config schema", () => {
  it("rejects unsupported Teams serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://dod.example.mil/teams",
    });

    expect(res.success).toBe(false);
  });

  it("accepts Azure China Bot Framework serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-China serviceUrl hosts when China cloud is configured", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://smba.trafficmanager.net/teams",
    });

    expect(res.success).toBe(false);
  });

  it("rejects Azure China Bot Framework serviceUrl hosts without China cloud", () => {
    const res = MSTeamsConfigSchema.safeParse({
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(false);
  });

  it("requires serviceUrl with non-public Teams clouds", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGov",
    });

    expect(res.success).toBe(false);
  });
});

describe("msTeamsApprovalAuth", () => {
  const ownerId = "123e4567-e89b-12d3-a456-426614174000";
  const otherUserId = "22222222-2222-4222-8222-222222222222";

  function authorizeApproval(allowFrom: string[], senderId: string) {
    return msTeamsApprovalAuth.authorizeActorAction({
      cfg: { channels: { msteams: { allowFrom } } },
      senderId,
      action: "approve",
      approvalKind: "exec",
    });
  }

  it("authorizes only the configured owner after normalizing an AAD principal", () => {
    const allowFrom = [`MSTEAMS:USER:${ownerId.toUpperCase()}`];
    expect(authorizeApproval(allowFrom, ownerId)).toEqual({ authorized: true });
    expect(authorizeApproval(allowFrom, otherUserId)).toMatchObject({ authorized: false });
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
