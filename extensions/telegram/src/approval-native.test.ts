import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it } from "vitest";
import { telegramApprovalCapability } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals: {
          enabled: true,
          approvers: ["8460800771"],
          target: "dm",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-approval-native-");

function createTempStorePath(): string {
  const dir = sessionDirs.make();
  return path.join(dir, "sessions.json");
}

async function writeSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await upsertSessionEntry(params);
}

describe("telegram native approval adapter", () => {
  const requestTimes = { createdAtMs: 0, expiresAtMs: 1000 };
  const multiApproverCfg: OpenClawConfig = {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals: { enabled: true, approvers: ["700000001", "700000002"], target: "dm" },
      },
    },
  };
  const approvalRequest = (
    id: string,
    turnSourceTo: string,
    turnSourceThreadId?: number,
    turnSourceAccountId: string | null = "default",
    sessionKey?: string,
  ) => ({
    ...requestTimes,
    id,
    request: {
      title: "Approval",
      description: "Review the change",
      command: "change setting",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"] as const,
      sessionId: "fixture-session",
      turnSourceChannel: "telegram",
      turnSourceTo,
      turnSourceThreadId,
      ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    },
  });
  const resolveApproverTargets = (
    request: ReturnType<typeof approvalRequest>,
    accountId = "default",
    targetCfg: OpenClawConfig = multiApproverCfg,
  ) => {
    const resolveTargets =
      telegramApprovalCapability.nativeAsync?.resolveApproverDmTargets ??
      telegramApprovalCapability.native?.resolveApproverDmTargets;
    return resolveTargets?.({
      cfg: targetCfg,
      accountId,
      approvalKind: "system-agent",
      request,
    });
  };

  it("keeps a matching private-chat approver in the validated origin topic", async () => {
    const targets = await resolveApproverTargets(
      approvalRequest("system-agent:topic-approval", "telegram:700000001", 42),
    );

    expect(targets).toEqual([{ to: "700000001", threadId: 42 }, { to: "700000002" }]);
  });

  it.each([
    [
      "direct-message topic",
      "telegram:700000001:direct-topic:77",
      undefined,
      { to: "700000001:direct-topic:77" },
    ],
    ["forum topic", "telegram:-100700000001:topic:77", undefined, { to: "700000001" }],
    ["different private user", "telegram:9999", 77, { to: "700000001" }],
  ] as const)(
    "leaves configured approver routes unchanged for %s",
    async (_name, to, threadId, expected) => {
      const targets = await resolveApproverTargets(
        approvalRequest("system-agent:unrelated-origin", to, threadId),
      );
      expect(targets).toEqual([expected, { to: "700000002" }]);
    },
  );

  it("does not carry a private topic across Telegram account scope", async () => {
    const targets = await resolveApproverTargets(
      approvalRequest("system-agent:other-account", "telegram:700000001", 42, "work"),
    );

    expect(targets).toEqual([]);
  });

  const twoAccountApproverCfg: OpenClawConfig = {
    channels: {
      telegram: {
        botToken: "default-token",
        execApprovals: { enabled: true, approvers: ["700000001", "700000002"], target: "dm" },
        accounts: {
          work: {
            botToken: "work-token",
            execApprovals: { enabled: true, approvers: ["700000001", "700000002"], target: "dm" },
          },
        },
      },
    },
  };

  it("keeps an unknown-account private topic out of every bot account", async () => {
    const request = approvalRequest(
      "system-agent:unknown-account-topic",
      "telegram:700000001",
      42,
      null,
    );

    for (const accountId of ["default", "work"]) {
      const targets = await resolveApproverTargets(request, accountId, twoAccountApproverCfg);
      expect(targets).toEqual([{ to: "700000001" }, { to: "700000002" }]);
    }
  });

  it("uses the saved Telegram account binding for private-topic delivery", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:telegram:direct:700000001";
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "work-session",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: "700000001",
            accountId: "work",
            threadId: "42",
          },
        }),
      },
    });
    const request = approvalRequest(
      "system-agent:saved-account-topic",
      "telegram:700000001",
      42,
      null,
      sessionKey,
    );
    const sessionCfg = { ...twoAccountApproverCfg, session: { store: storePath } };

    const workTargets = await resolveApproverTargets(request, "work", sessionCfg);
    const defaultTargets = await resolveApproverTargets(request, "default", sessionCfg);

    expect(workTargets).toEqual([{ to: "700000001", threadId: 42 }, { to: "700000002" }]);
    expect(defaultTargets).toEqual([]);
  });

  it.each([undefined, "work"])(
    "reserves terminal UI recovery for plugin approvals on account %s",
    (accountId) => {
      const params = { channel: "telegram", channelLabel: "Telegram", accountId };
      const execText = telegramApprovalCapability.describeExecApprovalSetup?.(params);
      const pluginText = telegramApprovalCapability.describePluginApprovalSetup?.(params);
      const prefix = accountId ? `channels.telegram.accounts.${accountId}` : "channels.telegram";

      expect(execText).toContain("Approve it from the Web UI for now.");
      expect(execText).not.toMatch(/terminal UI|\bTUI\b/i);
      expect(pluginText).toContain("Approve it from the Web UI or terminal UI for now.");
      expect(pluginText).toContain("Telegram supports native plugin approvals");
      expect(execText).toContain(`\`${prefix}.execApprovals.approvers\``);
      expect(pluginText).toContain(`\`${prefix}.execApprovals.approvers\``);
    },
  );

  it("normalizes direct-chat origin targets so DM dedupe can converge", async () => {
    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:8460800771",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:direct:8460800771",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "8460800771",
      threadId: undefined,
    });
  });

  it("parses topic-scoped turn-source targets in the extension", async () => {
    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-topic-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:topic:928",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });

  it("preserves channel Direct Messages topic targets from the turn source", async () => {
    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "system-agent",
      request: {
        id: "req-direct-topic-1",
        request: {
          command: "set config gateway.port 19001",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:direct-topic:77",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:group:-1003841603622:direct-topic:77",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622:direct-topic:77",
      threadId: undefined,
    });
  });

  it("parses numeric string thread ids from the session store for plugin approvals", async () => {
    const storePath = createTempStorePath();
    await writeSessionEntry({
      storePath,
      sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: "-1003841603622",
            accountId: "default",
            threadId: "928",
          },
        }),
      },
    });

    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig(),
        session: { store: storePath },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-2",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });
});
