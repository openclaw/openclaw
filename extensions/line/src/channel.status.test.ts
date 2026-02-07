import type { ChannelAccountSnapshot, ResolvedLineAccount } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

describe("LINE collectStatusIssues", () => {
  const collectStatusIssues = linePlugin.status!.collectStatusIssues!;

  it("returns no issues when account snapshot is configured", () => {
    const snapshot: ChannelAccountSnapshot = {
      accountId: "default",
      configured: true,
      tokenSource: "file",
    };

    const issues = collectStatusIssues([snapshot]);
    expect(issues).toEqual([]);
  });

  it("returns config issue when account snapshot is not configured", () => {
    const snapshot: ChannelAccountSnapshot = {
      accountId: "default",
      configured: false,
    };

    const issues = collectStatusIssues([snapshot]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({
      channel: "line",
      accountId: "default",
      kind: "config",
    });
  });

  it("returns config issue when configured field is undefined (not set)", () => {
    const snapshot: ChannelAccountSnapshot = {
      accountId: "default",
      // configured is omitted — should be treated as not configured
    };

    const issues = collectStatusIssues([snapshot]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({
      channel: "line",
      kind: "config",
    });
  });

  it("handles multiple accounts with mixed configuration", () => {
    const snapshots: ChannelAccountSnapshot[] = [
      { accountId: "configured-account", configured: true, tokenSource: "file" },
      { accountId: "unconfigured-account", configured: false },
    ];

    const issues = collectStatusIssues(snapshots);
    // Only the unconfigured account should have issues
    expect(issues.every((i) => i.accountId === "unconfigured-account")).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("LINE buildAccountSnapshot", () => {
  const buildAccountSnapshot = linePlugin.status!.buildAccountSnapshot!;

  function makeAccount(overrides: Partial<ResolvedLineAccount> = {}): ResolvedLineAccount {
    return {
      accountId: "default",
      enabled: true,
      channelAccessToken: "test-token-123",
      channelSecret: "test-secret-456",
      tokenSource: "inline",
      config: {},
      ...overrides,
    };
  }

  it("sets configured=true when both token and secret are present", () => {
    const snapshot = buildAccountSnapshot({
      account: makeAccount(),
      runtime: undefined,
      probe: undefined,
    });

    expect(snapshot.configured).toBe(true);
  });

  it("sets configured=false when channelAccessToken is empty", () => {
    const snapshot = buildAccountSnapshot({
      account: makeAccount({ channelAccessToken: "", channelSecret: "" }),
      runtime: undefined,
      probe: undefined,
    });

    expect(snapshot.configured).toBe(false);
  });

  it("sets configured=false when channelAccessToken is whitespace-only", () => {
    const snapshot = buildAccountSnapshot({
      account: makeAccount({ channelAccessToken: "   " }),
      runtime: undefined,
      probe: undefined,
    });

    expect(snapshot.configured).toBe(false);
  });

  it("sets configured=false when channelSecret is missing", () => {
    const snapshot = buildAccountSnapshot({
      account: makeAccount({ channelSecret: "" }),
      runtime: undefined,
      probe: undefined,
    });

    expect(snapshot.configured).toBe(false);
  });
});

describe("LINE isConfigured", () => {
  const isConfigured = linePlugin.config.isConfigured!;

  function makeAccount(overrides: Partial<ResolvedLineAccount> = {}): ResolvedLineAccount {
    return {
      accountId: "default",
      enabled: true,
      channelAccessToken: "test-token",
      channelSecret: "test-secret",
      tokenSource: "inline",
      config: {},
      ...overrides,
    };
  }

  it("returns true when both token and secret are present", () => {
    expect(isConfigured(makeAccount())).toBe(true);
  });

  it("returns false when channelAccessToken is empty", () => {
    expect(isConfigured(makeAccount({ channelAccessToken: "" }))).toBe(false);
  });

  it("returns false when channelSecret is empty", () => {
    expect(isConfigured(makeAccount({ channelSecret: "" }))).toBe(false);
  });
});

describe("LINE describeAccount", () => {
  const describeAccount = linePlugin.config.describeAccount!;

  function makeAccount(overrides: Partial<ResolvedLineAccount> = {}): ResolvedLineAccount {
    return {
      accountId: "default",
      enabled: true,
      channelAccessToken: "test-token",
      channelSecret: "test-secret",
      tokenSource: "inline",
      config: {},
      ...overrides,
    };
  }

  it("sets configured=true when both token and secret are present", () => {
    const desc = describeAccount(makeAccount());
    expect(desc.configured).toBe(true);
  });

  it("sets configured=false when channelSecret is empty", () => {
    const desc = describeAccount(makeAccount({ channelSecret: "" }));
    expect(desc.configured).toBe(false);
  });
});
