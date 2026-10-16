// Slack tests cover approval native plugin behavior.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";
import {
  buildConfig,
  buildPluginRequest,
  createExecApprovalRequest,
} from "./approval-native.test-support.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackInstallationStateRegistration = ReturnType<typeof registerSlackInstallationState>;

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-slack-approval-native-");
const installationStates: SlackInstallationStateRegistration[] = [];

afterEach(() => {
  for (const installationState of installationStates.splice(0)) {
    installationState.release();
  }
});

function createTempStorePath(): string {
  const dir = sessionDirs.make();
  return path.join(dir, "sessions.json");
}

async function resolvePluginOriginTarget(sessionKey: string) {
  const storePath = createTempStorePath();
  return await slackApprovalCapability.nativeAsync?.resolveOriginTarget?.({
    cfg: {
      ...buildConfig({ allowFrom: ["U123OWNER"] }),
      session: { store: storePath },
    },
    accountId: "default",
    approvalKind: "plugin",
    request: buildPluginRequest({ sessionKey }, "plugin:req-session"),
  });
}

describe("slack native approval adapter", () => {
  it("keeps approval availability enabled when approvers exist but native delivery is off", async () => {
    const cfg = buildConfig({
      execApprovals: {
        enabled: false,
        approvers: ["U123APPROVER"],
        target: "channel",
      },
    });

    expect(
      await slackApprovalCapability?.getActionAvailabilityStateAsync?.({
        cfg,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      await slackApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-disabled-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123",
            turnSourceAccountId: "default",
            sessionKey: "agent:main:slack:channel:c123",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({
      enabled: false,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("preserves the Grid team on approval origin and approver DM targets", async () => {
    const cfg = buildConfig();
    installationStates.push(registerSlackInstallationState("default", "enterprise"));
    const request = {
      ...createExecApprovalRequest(),
      request: {
        ...createExecApprovalRequest().request,
        turnSourceTo: "team:T123:channel:C123",
      },
    };

    expect(
      await slackApprovalCapability.nativeAsync?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: "team:T123:channel:C123",
      threadId: "1712345678.123456",
    });
    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual([{ to: "team:T123:user:U123APPROVER" }]);
  });

  it("selects plugin approver DMs for the validated Grid workspace", async () => {
    const cfg = buildConfig({
      allowFrom: ["team:T11111111:user:U111OWNER", "U222OWNER"],
      execApprovals: { enabled: "auto", target: "dm" },
    });
    installationStates.push(registerSlackInstallationState("default", "enterprise"));
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceAccountId: "default",
      turnSourceTo: "team:T11111111:channel:C11111111",
    });

    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([{ to: "team:T11111111:user:U111OWNER" }, { to: "team:T11111111:user:U222OWNER" }]);
    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request: {
          ...request,
          request: { ...request.request, turnSourceTo: "team:T22222222:channel:C22222222" },
        },
      }),
    ).toEqual([{ to: "team:T22222222:user:U222OWNER" }]);
    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request: {
          ...request,
          request: { ...request.request, turnSourceTo: "channel:C11111111" },
        },
      }),
    ).toEqual([]);
  });

  it("does not enable Grid approval delivery without a trusted team-qualified origin", async () => {
    installationStates.push(registerSlackInstallationState("default", "enterprise"));
    const capabilities = await slackApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: createExecApprovalRequest(),
    });

    expect(capabilities?.enabled).toBe(false);
  });

  it("enables native plugin delivery from plugin approvers without exec approvers", async () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: {
        enabled: true,
        target: "dm",
      },
    });
    const request = buildPluginRequest({
      turnSourceChannel: "slack",
      turnSourceAccountId: "default",
    });

    expect(
      (
        await slackApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
          cfg,
          accountId: "default",
          approvalKind: "plugin",
          request,
        })
      )?.enabled,
    ).toBe(true);
    expect(
      (
        await slackApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
          cfg,
          accountId: "default",
          approvalKind: "exec",
          request: {
            id: "req-1",
            request: {
              command: "echo hi",
              turnSourceChannel: "slack",
              turnSourceAccountId: "default",
            },
            createdAtMs: 0,
            expiresAtMs: 1000,
          },
        })
      )?.enabled,
    ).toBe(false);
    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([{ to: "user:U123OWNER" }]);
    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.isConfigured({
        cfg,
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
    expect(
      await slackApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync?.({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "user:U123OWNER", accountId: "default" },
        request,
      }),
    ).toBe(true);
  });

  it("delivers plugin forwarding session approvals to the Slack origin without concrete approvers", async () => {
    const cfg = {
      ...buildConfig({
        allowFrom: ["*"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "dm",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "session",
          sessionFilter: ["slack:"],
        },
      },
    } as unknown as OpenClawConfig;
    const request = buildPluginRequest(
      {
        sessionKey: "slack:D123APPROVALS:test-run",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:D123APPROVALS",
        turnSourceAccountId: "default",
      },
      "plugin:req-open-session",
    );

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.isConfigured({
        cfg,
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
    expect(
      await slackApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
    expect(
      await slackApprovalCapability.nativeAsync?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual({
      to: "channel:D123APPROVALS",
      threadId: undefined,
    });
  });

  it("requires Slack socket transport readiness before plugin forwarding enables native delivery", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "xoxb-work",
              allowFrom: ["U123OWNER"],
              execApprovals: {
                enabled: false,
                target: "both",
              },
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", accountId: "work", to: "user:U123OWNER" }],
        },
      },
    } as unknown as OpenClawConfig;
    const request = buildPluginRequest({}, "plugin:req-transport");

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.isConfigured({
        cfg,
        accountId: "work",
      }),
    ).toBe(false);
    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(false);
    expect(
      (
        await slackApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
          cfg,
          accountId: "work",
          approvalKind: "plugin",
          request,
        })
      )?.enabled,
    ).toBe(false);
  });

  it("treats HTTP signing secret SecretRefs as Slack transport readiness", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              mode: "http",
              botToken: "xoxb-work",
              signingSecret: {
                source: "env",
                id: "SLACK_SIGNING_SECRET",
              },
              allowFrom: ["U123OWNER"],
              execApprovals: {
                enabled: false,
                target: "both",
              },
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", accountId: "work", to: "user:U123OWNER" }],
        },
      },
    } as unknown as OpenClawConfig;
    const request = buildPluginRequest({}, "plugin:req-http-secret-ref");

    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.isConfigured({
        cfg,
        accountId: "work",
      }),
    ).toBe(true);
    expect(
      await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
  });

  it("routes plugin session fallback off-thread and follows account changes", async () => {
    const storePath = createTempStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:slack:channel:c999",
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", accountId: "work" },
        }),
      },
    });

    const cfg = {
      ...buildConfig({ allowFrom: ["U123OWNER"] }),
      session: { store: storePath },
      approvals: {
        plugin: {
          enabled: true,
          mode: "session",
        },
      },
    } as OpenClawConfig;
    const request = buildPluginRequest(
      {
        sessionKey: "agent:main:slack:channel:c999",
      },
      "plugin:req-account-bound",
    );

    const assertRoutes = async (expectedDefault: boolean, expectedWork: boolean) => {
      const sql = observeHostDataSql();
      try {
        expect(
          await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
            cfg,
            accountId: "default",
            approvalKind: "plugin",
            request,
          }),
        ).toBe(expectedDefault);
        expect(
          await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
            cfg,
            accountId: "default",
            approvalKind: "plugin",
            request,
          }),
        ).toEqual(expectedDefault ? [{ to: "user:U123OWNER" }] : []);
        expect(
          await slackApprovalCapability.nativeRuntimeAsync?.availability.shouldHandle({
            cfg,
            accountId: "work",
            approvalKind: "plugin",
            request,
          }),
        ).toBe(expectedWork);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    };
    await assertRoutes(false, true);
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:slack:channel:c999",
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "slack", accountId: "default" },
        }),
      },
    });
    await assertRoutes(true, false);
  });

  it("resolves Slack app conversation plugin approvals to the live D-channel thread", async () => {
    const target = await slackApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig({ allowFrom: ["U123OWNER"] }),
      accountId: "default",
      approvalKind: "plugin",
      request: buildPluginRequest({
        sessionKey: "agent:main:slack:direct:u123owner:thread:1712345678.123456",
        turnSourceChannel: "slack",
        turnSourceTo: "D0ACP6B1T8V",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      }),
    });

    expect(target).toEqual({
      to: "channel:D0ACP6B1T8V",
      threadId: "1712345678.123456",
    });
  });

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await resolvePluginOriginTarget(
      "agent:main:slack:channel:c08gqh53ejm:thread:1712345678.123456",
    );

    expect(target).toEqual({
      to: "channel:C08GQH53EJM",
      threadId: "1712345678.123456",
    });
  });

  it("preserves an enterprise-qualified session fallback instead of rewriting its segments", async () => {
    const target = await resolvePluginOriginTarget(
      "agent:main:slack:channel:team:T123:channel:C08GQH53EJM",
    );

    expect(target).toEqual({
      to: "team:T123:channel:C08GQH53EJM",
      threadId: undefined,
    });
  });

  it.each([
    { reason: "another Slack account", agentId: "main", turnSourceAccountId: "other" },
    {
      reason: "a nonmatching agent filter",
      agentId: "other-agent",
      turnSourceAccountId: "default",
    },
  ])("skips origin and DM delivery for $reason", async ({ agentId, turnSourceAccountId }) => {
    const params = {
      cfg: buildConfig({
        execApprovals: {
          enabled: true,
          approvers: ["U123APPROVER"],
          target: "both",
          agentFilter: ["main"],
        },
      }),
      accountId: "default",
      approvalKind: "exec" as const,
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          agentId,
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId,
          sessionKey: `agent:${agentId}:slack:channel:c123`,
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    };

    expect(await slackApprovalCapability.nativeAsync?.resolveOriginTarget?.(params)).toBeNull();
    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.(params),
    ).toStrictEqual([]);
  });

  it("suppresses generic slack fallback only for slack-originated approvals", async () => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      await shouldSuppress({
        cfg: buildConfig(),
        approvalKind: "exec",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
        request: {
          id: "approval-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(true);

    expect(
      await shouldSuppress({
        cfg: buildConfig(),
        approvalKind: "exec",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
        request: {
          id: "approval-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "discord",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(false);
  });

  it("keeps plugin forwarding fallback when Slack has no plugin approvers", async () => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      await shouldSuppress({
        cfg: buildConfig({
          execApprovals: {
            enabled: true,
            approvers: ["U999EXEC"],
            target: "dm",
          },
        }),
        approvalKind: "plugin",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
        request: buildPluginRequest(
          {
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          "plugin:approval-1",
        ),
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "suppresses plugin forwarding fallback for the native origin target",
      threadId: "1712345678.123456",
      expected: true,
    },
    {
      name: "keeps plugin forwarding fallback when the native origin thread timestamp differs",
      threadId: "1712345678.1234567",
      expected: false,
    },
  ])("$name", async ({ threadId, expected }) => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }
    expect(
      await shouldSuppress({
        cfg: buildConfig({
          allowFrom: ["U123OWNER"],
          execApprovals: {
            enabled: true,
            approvers: ["U999EXEC"],
            target: "dm",
          },
        }),
        approvalKind: "plugin",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default", threadId },
        request: buildPluginRequest(
          {
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123ROOM",
            turnSourceAccountId: "default",
            turnSourceThreadId: "1712345678.123456",
          },
          "plugin:approval-1",
        ),
      }),
    ).toBe(expected);
  });

  it("suppresses bare Slack user plugin forwarding targets handled by native DM delivery", async () => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    const cfg = {
      ...buildConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "both",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123OWNER" }],
        },
      },
    } as OpenClawConfig;

    expect(
      await shouldSuppress({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "U123OWNER", accountId: "default" },
        request: buildPluginRequest(
          {
            turnSourceChannel: "slack",
            turnSourceTo: "user:U123OWNER",
            turnSourceAccountId: "default",
            sessionKey: "agent:main:slack:direct:U123OWNER",
          },
          "plugin:approval-1",
        ),
      }),
    ).toBe(true);
  });

  it("keeps explicit plugin forwarding channel targets outside native Slack delivery", async () => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallbackAsync;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    const cfg = {
      ...buildConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "both",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "channel:CAPPROVALS" }],
        },
      },
    } as OpenClawConfig;

    expect(
      await shouldSuppress({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "channel:CAPPROVALS", accountId: "default" },
        request: buildPluginRequest({}, "plugin:approval-1"),
      }),
    ).toBe(false);
  });

  it("lets only the current typed Slack owner approve owner-derived exec requests", async () => {
    const cfg = {
      ...buildConfig({
        execApprovals: { enabled: "auto", target: "dm" },
        accounts: {
          ops: {
            botToken: "xoxb-ops",
            appToken: "xapp-ops",
            execApprovals: { enabled: "auto", approvers: ["U0777OTHER"], target: "dm" },
          },
        },
      }),
      commands: { ownerAllowFrom: ["slack:user:U0123ABCD"] },
    } as OpenClawConfig;
    const authorize = async (
      senderId: string,
      options: { cfg?: OpenClawConfig; accountId?: string } = {},
    ) =>
      (
        await slackApprovalCapability.authorizeActorActionAsync?.({
          cfg: options.cfg ?? cfg,
          accountId: options.accountId ?? "default",
          senderId,
          action: "approve",
          approvalKind: "exec",
        })
      )?.authorized;

    expect(
      await slackApprovalCapability.nativeAsync?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: createExecApprovalRequest(),
      }),
    ).toEqual([{ to: "user:U0123ABCD" }]);
    expect(await authorize("U0123ABCD")).toBe(true);
    expect(await authorize("U0666NOPE")).toBe(false);
    // Explicit account approvers still replace the global owner fallback.
    expect(await authorize("U0123ABCD", { accountId: "ops" })).toBe(false);
    // Authority is read from the config current at decision time.
    expect(
      await authorize("U0123ABCD", {
        cfg: { ...cfg, commands: { ownerAllowFrom: ["slack:user:U0888NEXT"] } },
      }),
    ).toBe(false);
  });

  it("keeps plugin approval auth independent from exec approvers", async () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: {
        enabled: true,
        approvers: ["U999EXEC"],
        target: "both",
      },
    });

    expect(
      await slackApprovalCapability.authorizeActorActionAsync?.({
        cfg,
        accountId: "default",
        senderId: "U123OWNER",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      await slackApprovalCapability.authorizeActorActionAsync?.({
        cfg,
        accountId: "default",
        senderId: "U999EXEC",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Slack.",
    });

    expect(
      await slackApprovalCapability.authorizeActorActionAsync?.({
        cfg,
        accountId: "default",
        senderId: "U999EXEC",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});

describe("Slack approval setup guidance", () => {
  it.each([
    ["default", "channels.slack"],
    ["work", "channels.slack.accounts.work"],
  ])("describes explicit Slack exec-approval setup for account %s", (accountId, prefix) => {
    const text = slackApprovalCapability.describeExecApprovalSetup?.({
      channel: "slack",
      channelLabel: "Slack",
      accountId,
    });

    expect(text).toContain(
      `Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\``,
    );
    expect(text).toContain(`set \`${prefix}.execApprovals.enabled\` to \`auto\` or \`true\``);
    expect(text).toContain("Unset or `false` disables native exec approval delivery.");
    expect(text).toContain("Approve it from the Web UI for now.");
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
    expect(text).not.toContain("`channels.slack.dm.allowFrom`");
  });

  it("guides plugin approvals to the scoped reviewer list and live bot workspace", () => {
    expect(
      slackApprovalCapability.describeExecApprovalSetup?.({
        channel: "slack",
        channelLabel: "Slack",
      }),
    ).toContain("`channels.slack.execApprovals.approvers`");
    const text = slackApprovalCapability.describePluginApprovalSetup?.({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work",
    });
    expect(text).toContain("`approvals.plugin.slack`");
    expect(text).toContain("bot's workspace");
    expect(text).toContain("Slack bot is connected");
    expect(text).not.toContain("execApprovals");
  });
});
