import path from "node:path";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it } from "vitest";
import { slackApprovalCapability as capability } from "./approval-native.js";
import {
  buildConfig,
  buildPluginRequest,
  createExecApprovalRequest,
  useSlackInstallations,
} from "./approval-native.test-support.js";

const native = capability.nativeAsync;
const origin = native?.resolveOriginTarget;
const targets = native?.resolveApproverDmTargets;
const delivery = native?.describeDeliveryCapabilities;
const actionState = capability.getActionAvailabilityStateAsync;
const availability = capability.nativeRuntimeAsync?.availability;
const shouldSuppress = capability.delivery?.shouldSuppressForwardingFallbackAsync;
type SuppressionInput = Parameters<NonNullable<typeof shouldSuppress>>[0];
type Route = Parameters<NonNullable<NonNullable<typeof native>["resolveOriginTarget"]>>[0];
function route(
  cfg: OpenClawConfig,
  request: Route["request"],
  approvalKind: Route["approvalKind"] = "plugin",
  accountId = "default",
): Route {
  return { cfg, request, approvalKind, accountId };
}

function suppress(
  cfg: OpenClawConfig,
  request: Route["request"],
  to = "channel:C123ROOM",
  approvalKind: Route["approvalKind"] = "plugin",
  threadId?: string,
) {
  return shouldSuppress?.({
    ...route(cfg, request, approvalKind),
    target: { channel: "slack", to, accountId: "default", threadId },
  } satisfies SuppressionInput);
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-slack-approval-native-");
const install = useSlackInstallations();

function createTempStorePath(): string {
  const dir = sessionDirs.make();
  return path.join(dir, "sessions.json");
}

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
function forwardingConfig(account: SlackConfig["accounts"]): OpenClawConfig {
  return {
    channels: { slack: { defaultAccount: "work", accounts: account } },
    approvals: {
      plugin: {
        enabled: true,
        mode: "targets",
        targets: [{ channel: "slack", accountId: "work", to: "user:U123OWNER" }],
      },
    },
  };
}

const workAccount: NonNullable<SlackConfig["accounts"]>[string] = {
  botToken: "xoxb-work",
  allowFrom: ["U123OWNER"],
  execApprovals: { enabled: false, target: "both" },
};

function pluginForwardingConfig(to: string): OpenClawConfig {
  return {
    ...buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: { enabled: false, approvers: ["U999EXEC"], target: "both" },
    }),
    approvals: { plugin: { enabled: true, mode: "targets", targets: [{ channel: "slack", to }] } },
  };
}

function execRequest(
  request: Partial<ExecApprovalRequest["request"]>,
  id = "req-1",
  expiresAtMs = 1000,
) {
  return { id, request: { command: "echo hi", ...request }, createdAtMs: 0, expiresAtMs };
}

function pluginOrigin(request: Parameters<typeof buildPluginRequest>[0] = {}) {
  return buildPluginRequest({
    turnSourceChannel: "slack",
    turnSourceAccountId: "default",
    ...request,
  });
}

async function resolvePluginOriginTarget(sessionKey: string) {
  const storePath = createTempStorePath();
  return await origin?.({
    cfg: { ...buildConfig({ allowFrom: ["U123OWNER"] }), session: { store: storePath } },
    accountId: "default",
    approvalKind: "plugin",
    request: buildPluginRequest({ sessionKey }, "plugin:req-session"),
  });
}

describe("slack native approval adapter", () => {
  it("keeps approval availability enabled when approvers exist but native delivery is off", async () => {
    const cfg = buildConfig({
      execApprovals: { enabled: false, approvers: ["U123APPROVER"], target: "channel" },
    });

    expect(
      await actionState?.({
        cfg,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      await delivery?.(
        route(
          cfg,
          execRequest(
            {
              turnSourceChannel: "slack",
              turnSourceTo: "channel:C123",
              turnSourceAccountId: "default",
              sessionKey: "agent:main:slack:channel:c123",
            },
            "req-disabled-1",
            1000,
          ),
          "exec",
        ),
      ),
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
    install("default", "enterprise");
    const request = {
      ...createExecApprovalRequest(),
      request: {
        ...createExecApprovalRequest().request,
        turnSourceTo: "team:T123:channel:C123",
      },
    };

    expect(await origin?.(route(cfg, request, "exec"))).toEqual({
      to: "team:T123:channel:C123",
      threadId: "1712345678.123456",
    });
    expect(await targets?.(route(cfg, request, "exec"))).toEqual([
      { to: "team:T123:user:U123APPROVER" },
    ]);
  });

  it("selects plugin approver DMs for the validated Grid workspace", async () => {
    const cfg = buildConfig({
      allowFrom: ["team:T11111111:user:U111OWNER", "U222OWNER"],
      execApprovals: { enabled: "auto", target: "dm" },
    });
    install("default", "enterprise");
    const request = pluginOrigin({
      turnSourceTo: "team:T11111111:channel:C11111111",
    });

    expect(await targets?.(route(cfg, request))).toEqual([
      { to: "team:T11111111:user:U111OWNER" },
      { to: "team:T11111111:user:U222OWNER" },
    ]);
    expect(
      await targets?.(
        route(cfg, {
          ...request,
          request: { ...request.request, turnSourceTo: "team:T22222222:channel:C22222222" },
        }),
      ),
    ).toEqual([{ to: "team:T22222222:user:U222OWNER" }]);
    expect(
      await targets?.(
        route(cfg, {
          ...request,
          request: { ...request.request, turnSourceTo: "channel:C11111111" },
        }),
      ),
    ).toEqual([]);
  });

  it("does not enable Grid approval delivery without a trusted team-qualified origin", async () => {
    install("default", "enterprise");
    const capabilities = await delivery?.(
      route(buildConfig(), createExecApprovalRequest(), "exec"),
    );

    expect(capabilities?.enabled).toBe(false);
  });

  it("enables native plugin delivery from plugin approvers without exec approvers", async () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: { enabled: true, target: "dm" },
    });
    const request = pluginOrigin();

    expect((await delivery?.(route(cfg, request)))?.enabled).toBe(true);
    expect(
      (
        await delivery?.(
          route(
            cfg,
            execRequest({ turnSourceChannel: "slack", turnSourceAccountId: "default" }),
            "exec",
          ),
        )
      )?.enabled,
    ).toBe(false);
    expect(await targets?.(route(cfg, request))).toEqual([{ to: "user:U123OWNER" }]);
    expect(await availability?.isConfigured({ cfg, accountId: "default" })).toBe(true);
    expect(await availability?.shouldHandle(route(cfg, request))).toBe(true);
    expect(await suppress(cfg, request, "user:U123OWNER")).toBe(true);
  });

  it("delivers plugin forwarding session approvals to the Slack origin without concrete approvers", async () => {
    const cfg = {
      ...buildConfig({
        allowFrom: ["*"],
        execApprovals: { enabled: false, approvers: ["U999EXEC"], target: "dm" },
      }),
      approvals: { plugin: { enabled: true, mode: "session", sessionFilter: ["slack:"] } },
    } as unknown as OpenClawConfig;
    const request = pluginOrigin({
      sessionKey: "slack:D123APPROVALS:test-run",
      turnSourceTo: "channel:D123APPROVALS",
    });

    expect(await availability?.isConfigured({ cfg, accountId: "default" })).toBe(true);
    expect(await availability?.shouldHandle(route(cfg, request))).toBe(true);
    expect(await delivery?.(route(cfg, request))).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
    expect(await origin?.(route(cfg, request))).toEqual({
      to: "channel:D123APPROVALS",
      threadId: undefined,
    });
  });

  it("requires Slack socket transport readiness before plugin forwarding enables native delivery", async () => {
    const cfg = forwardingConfig({ work: workAccount });
    const request = buildPluginRequest({}, "plugin:req-transport");

    expect(await availability?.isConfigured({ cfg, accountId: "work" })).toBe(false);
    expect(await availability?.shouldHandle(route(cfg, request, "plugin", "work"))).toBe(false);
    expect((await delivery?.(route(cfg, request, "plugin", "work")))?.enabled).toBe(false);
  });

  it("treats HTTP signing secret SecretRefs as Slack transport readiness", async () => {
    const cfg = forwardingConfig({
      work: {
        ...workAccount,
        mode: "http",
        signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
      },
    });
    const request = buildPluginRequest({}, "plugin:req-http-secret-ref");

    expect(await availability?.isConfigured({ cfg, accountId: "work" })).toBe(true);
    expect(await availability?.shouldHandle(route(cfg, request, "plugin", "work"))).toBe(true);
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
      approvals: { plugin: { enabled: true, mode: "session" } },
    } as OpenClawConfig;
    const request = buildPluginRequest(
      { sessionKey: "agent:main:slack:channel:c999" },
      "plugin:req-account-bound",
    );

    const assertRoutes = async (expectedDefault: boolean, expectedWork: boolean) => {
      const sql = observeHostDataSql();
      try {
        expect(await availability?.shouldHandle(route(cfg, request))).toBe(expectedDefault);
        expect(await targets?.(route(cfg, request))).toEqual(
          expectedDefault ? [{ to: "user:U123OWNER" }] : [],
        );
        expect(await availability?.shouldHandle(route(cfg, request, "plugin", "work"))).toBe(
          expectedWork,
        );
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
    const target = await origin?.({
      cfg: buildConfig({ allowFrom: ["U123OWNER"] }),
      accountId: "default",
      approvalKind: "plugin",
      request: pluginOrigin({
        sessionKey: "agent:main:slack:direct:u123owner:thread:1712345678.123456",
        turnSourceTo: "D0ACP6B1T8V",
        turnSourceThreadId: "1712345678.123456",
      }),
    });

    expect(target).toEqual({ to: "channel:D0ACP6B1T8V", threadId: "1712345678.123456" });
  });

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await resolvePluginOriginTarget(
      "agent:main:slack:channel:c08gqh53ejm:thread:1712345678.123456",
    );

    expect(target).toEqual({ to: "channel:C08GQH53EJM", threadId: "1712345678.123456" });
  });

  it("preserves an enterprise-qualified session fallback instead of rewriting its segments", async () => {
    const target = await resolvePluginOriginTarget(
      "agent:main:slack:channel:team:T123:channel:C08GQH53EJM",
    );

    expect(target).toEqual({ to: "team:T123:channel:C08GQH53EJM", threadId: undefined });
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
      request: execRequest(
        {
          agentId,
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId,
          sessionKey: `agent:${agentId}:slack:channel:c123`,
        },
        "req-1",
        1000,
      ),
    };

    expect(await origin?.(params)).toBeNull();
    expect(await targets?.(params)).toStrictEqual([]);
  });

  it.each([
    ["slack", true],
    ["discord", false],
  ] as const)("suppresses generic fallback from %s: %s", async (turnSourceChannel, expected) => {
    expect(
      await suppress(
        buildConfig(),
        execRequest({ turnSourceChannel, turnSourceAccountId: "default" }),
        "channel:C123ROOM",
        "exec",
      ),
    ).toBe(expected);
  });

  it("keeps plugin forwarding fallback when Slack has no plugin approvers", async () => {
    expect(
      await suppress(
        buildConfig({
          execApprovals: { enabled: true, approvers: ["U999EXEC"], target: "dm" },
        }),
        pluginOrigin(),
      ),
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
    expect(
      await suppress(
        buildConfig({
          allowFrom: ["U123OWNER"],
          execApprovals: { enabled: true, approvers: ["U999EXEC"], target: "dm" },
        }),
        pluginOrigin({
          turnSourceTo: "channel:C123ROOM",
          turnSourceThreadId: "1712345678.123456",
        }),
        "channel:C123ROOM",
        "plugin",
        threadId,
      ),
    ).toBe(expected);
  });

  it("suppresses bare Slack user plugin forwarding targets handled by native DM delivery", async () => {
    const cfg = pluginForwardingConfig("U123OWNER");

    expect(
      await suppress(
        cfg,
        pluginOrigin({
          turnSourceTo: "user:U123OWNER",
          sessionKey: "agent:main:slack:direct:U123OWNER",
        }),
        "U123OWNER",
      ),
    ).toBe(true);
  });

  it("keeps explicit plugin forwarding channel targets outside native Slack delivery", async () => {
    const cfg = pluginForwardingConfig("channel:CAPPROVALS");

    expect(
      await suppress(cfg, buildPluginRequest({}, "plugin:approval-1"), "channel:CAPPROVALS"),
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
        await capability.authorizeActorActionAsync?.({
          cfg: options.cfg ?? cfg,
          accountId: options.accountId ?? "default",
          senderId,
          action: "approve",
          approvalKind: "exec",
        })
      )?.authorized;

    expect(await targets?.(route(cfg, createExecApprovalRequest(), "exec"))).toEqual([
      { to: "user:U0123ABCD" },
    ]);
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
      execApprovals: { enabled: true, approvers: ["U999EXEC"], target: "both" },
    });

    const authorize = (senderId: string, approvalKind: "plugin" | "exec") =>
      capability.authorizeActorActionAsync?.({
        cfg,
        accountId: "default",
        senderId,
        action: "approve",
        approvalKind,
      });
    expect(await authorize("U123OWNER", "plugin")).toEqual({ authorized: true });
    expect(await authorize("U999EXEC", "plugin")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Slack.",
    });

    expect(await authorize("U999EXEC", "exec")).toEqual({ authorized: true });
  });
});

describe("Slack approval setup guidance", () => {
  it.each([
    ["default", "channels.slack"],
    ["work", "channels.slack.accounts.work"],
  ])("describes explicit Slack exec-approval setup for account %s", (accountId, prefix) => {
    const text = capability.describeExecApprovalSetup?.({
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
      capability.describeExecApprovalSetup?.({ channel: "slack", channelLabel: "Slack" }),
    ).toContain("`channels.slack.execApprovals.approvers`");
    const text = capability.describePluginApprovalSetup?.({
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
