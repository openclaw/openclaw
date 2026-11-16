import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it } from "vitest";
import { telegramApprovalCapability } from "./approval-native.js";

const execApprovals = { enabled: true, approvers: ["700000001"], target: "dm" as const };
const cfg: OpenClawConfig = { channels: { telegram: { botToken: "tok", execApprovals } } };
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-approval-native-");
const requestTimes = { createdAtMs: 0, expiresAtMs: 1000 };
const chatId = "-1003841603622";
const directTopic = `${chatId}:direct-topic:77`;

describe("telegram native approval adapter", () => {
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

  it.each([
    ["direct:700000001", "700000001", "700000001", undefined, "exec"],
    [`group:${chatId}:topic:928`, `${chatId}:topic:928`, chatId, 928, "exec"],
    [`group:${directTopic}`, directTopic, directTopic, undefined, "system-agent"],
  ] as const)(
    "resolves the turn-source target for %s",
    async (session, source, to, threadId, approvalKind) => {
      const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind,
        request: {
          ...requestTimes,
          id: "req-1",
          request: {
            command: approvalKind === "exec" ? "echo hi" : "set config gateway.port 19001",
            turnSourceChannel: "telegram",
            turnSourceTo: `telegram:${source}`,
            turnSourceAccountId: "default",
            sessionKey: `agent:main:telegram:${session}`,
          },
        },
      });
      expect(target).toEqual({ to, threadId });
    },
  );

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

  it("parses numeric string thread ids from the session store for plugin approvals", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = `agent:main:telegram:group:${chatId}:topic:928`;
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: chatId,
            accountId: "default",
            threadId: "928",
          },
        }),
      },
    });

    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: { ...cfg, session: { store: storePath } },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        ...requestTimes,
        id: "plugin:req-2",
        request: { title: "Plugin approval", description: "Allow access", sessionKey },
      },
    });

    expect(target).toEqual({ to: chatId, threadId: 928 });
  });

  // Gateway sessions store forum topics as `telegram:<chat>:topic:<id>`, like the live turn.
  it.each([
    ["928", { to: chatId, threadId: 928 }],
    ["111", null],
  ] as const)("matches a stored forum topic route against live topic %s", async (thread, want) => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = `agent:main:telegram:group:${chatId}:topic:928`;
    const route = `telegram:${chatId}:topic:928`;
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: route, accountId: "default", threadId: 928 },
        }),
      },
    });

    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: { ...cfg, session: { store: storePath } },
      accountId: "default",
      approvalKind: "exec",
      request: {
        ...requestTimes,
        id: "req-3",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: `telegram:${chatId}:topic:${thread}`,
          turnSourceThreadId: thread,
          turnSourceAccountId: "default",
          sessionKey,
        },
      },
    });

    expect(target ?? null).toEqual(want);
  });
});
