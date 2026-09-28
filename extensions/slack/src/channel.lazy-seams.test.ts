import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { setSlackRuntime } from "./runtime.js";

const collectAuditFindingsMock = vi.hoisted(() => vi.fn());
const fetchSlackScopesMock = vi.hoisted(() => vi.fn());
const resolveTargetsWithOptionalTokenMock = vi.hoisted(() => vi.fn());
const buildPassiveProbedChannelStatusSummaryMock = vi.hoisted(() => vi.fn());
vi.mock("./security-audit.js", () => ({
  collectSlackSecurityAuditFindings: collectAuditFindingsMock,
}));

vi.mock("./scopes.js", () => ({
  fetchSlackScopes: fetchSlackScopesMock,
}));

vi.mock("openclaw/plugin-sdk/target-resolver-runtime", async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return {
    ...original,
    resolveTargetsWithOptionalToken: resolveTargetsWithOptionalTokenMock,
  };
});

vi.mock("openclaw/plugin-sdk/extension-shared", async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return {
    ...original,
    buildPassiveProbedChannelStatusSummary: buildPassiveProbedChannelStatusSummaryMock,
  };
});

beforeEach(() => {
  collectAuditFindingsMock.mockReset();
  fetchSlackScopesMock.mockReset();
  resolveTargetsWithOptionalTokenMock.mockReset();
  buildPassiveProbedChannelStatusSummaryMock.mockReset();
  setSlackRuntime({ channel: { slack: {} } } as never);
});

function makeMinimalSlackConfig(
  opts: { botToken?: string; userToken?: string } = {},
): OpenClawConfig {
  return { channels: { slack: opts } };
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function mockCallAt(mock: MockWithCalls, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call;
}

function mockRecordArgAt(mock: MockWithCalls, callIndex: number, argIndex: number) {
  const value = mockCallAt(mock, callIndex)[argIndex];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected mock call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

describe("slackPlugin.status.buildChannelSummary lazy SDK forwarding", () => {
  it("calls the lazy extension-shared SDK helper with the snapshot and token sources, and returns its output unchanged", async () => {
    const buildChannelSummary = slackPlugin.status!.buildChannelSummary!;

    const sentinelSummary = { sentinel: "passive-summary" };
    buildPassiveProbedChannelStatusSummaryMock.mockReturnValue(sentinelSummary);

    const snapshot = {
      accountId: "default",
      configured: true,
      enabled: true,
      botTokenSource: "config" as const,
      appTokenSource: "config" as const,
      extra: { custom: 1 },
    };

    const result = await buildChannelSummary({
      account: { accountId: "default" } as never,
      snapshot,
      cfg: makeMinimalSlackConfig({ botToken: "xoxb-test" }),
      runtime: undefined,
    } as never);

    expect(buildPassiveProbedChannelStatusSummaryMock).toHaveBeenCalledTimes(1);
    const [forwardedSnapshot, forwardedExtras] = mockCallAt(
      buildPassiveProbedChannelStatusSummaryMock,
      0,
    );
    expect(forwardedSnapshot).toBe(snapshot);
    expect(forwardedExtras).toEqual({ botTokenSource: "config", appTokenSource: "config" });
    expect(result).toBe(sentinelSummary);
  });

  it("falls back to 'none' for missing token sources before forwarding to the SDK helper", async () => {
    const buildChannelSummary = slackPlugin.status!.buildChannelSummary!;

    buildPassiveProbedChannelStatusSummaryMock.mockReturnValue({ sentinel: true });

    await buildChannelSummary({
      account: { accountId: "default" } as never,
      snapshot: { accountId: "default", configured: false, enabled: true } as never,
      cfg: makeMinimalSlackConfig(),
      runtime: undefined,
    } as never);

    const [, forwardedExtras] = mockCallAt(buildPassiveProbedChannelStatusSummaryMock, 0);
    expect(forwardedExtras).toEqual({ botTokenSource: "none", appTokenSource: "none" });
  });
});

describe("slackPlugin.status.buildCapabilitiesDiagnostics lazy scopes loader", () => {
  it("invokes fetchSlackScopes twice (bot and user) when both tokens are present", async () => {
    const buildDiagnostics = slackPlugin.status!.buildCapabilitiesDiagnostics!;

    fetchSlackScopesMock
      .mockResolvedValueOnce({ ok: true, scopes: ["chat:write"] })
      .mockResolvedValueOnce({ ok: true, scopes: ["users:read"] });

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot", userToken: "xoxp-user" });
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await buildDiagnostics({ account, timeoutMs: 5000, cfg } as never);

    expect(fetchSlackScopesMock).toHaveBeenCalledTimes(2);
    expect(mockCallAt(fetchSlackScopesMock, 0)).toEqual(["xoxb-bot", 5000]);
    expect(mockCallAt(fetchSlackScopesMock, 1)).toEqual(["xoxp-user", 5000]);
    expect(result?.details).toEqual({
      botScopes: { ok: true, scopes: ["chat:write"] },
      userScopes: { ok: true, scopes: ["users:read"] },
    });
  });

  it("does not invoke fetchSlackScopes when no bot token is present and reports a missing-token diagnostic", async () => {
    const buildDiagnostics = slackPlugin.status!.buildCapabilitiesDiagnostics!;

    const cfg = makeMinimalSlackConfig();
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await buildDiagnostics({ account, timeoutMs: 1000, cfg } as never);

    expect(fetchSlackScopesMock).not.toHaveBeenCalled();
    expect(result?.details).toEqual({
      botScopes: { ok: false, error: "Slack bot token missing." },
    });
  });
});

describe("slackPlugin.security.collectAuditFindings lazy module forwarding", () => {
  it("delegates to the lazy security-audit module with the original params and returns its output", async () => {
    const collectAuditFindings = slackPlugin.security!.collectAuditFindings!;

    const sentinel = [
      {
        checkId: "test-check",
        severity: "info" as const,
        title: "t",
        detail: "d",
      },
    ];
    collectAuditFindingsMock.mockResolvedValue(sentinel);

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot" });
    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const result = await collectAuditFindings({ cfg, accountId: "default", account } as never);

    expect(collectAuditFindingsMock).toHaveBeenCalledTimes(1);
    expect(mockCallAt(collectAuditFindingsMock, 0)[0]).toEqual({
      cfg,
      accountId: "default",
      account,
    });
    expect(result).toBe(sentinel);
  });
});

describe("slackPlugin.resolver.resolveTargets lazy SDK forwarding", () => {
  it("forwards user inputs and the configured token to the lazy SDK helper and returns its output", async () => {
    const resolveTargets = slackPlugin.resolver!.resolveTargets!;

    const sentinelOutput = [{ input: "U123", resolved: true, id: "U123", note: undefined }];
    resolveTargetsWithOptionalTokenMock.mockResolvedValue(sentinelOutput);

    const cfg = makeMinimalSlackConfig({ botToken: "xoxb-bot" });
    const result = await resolveTargets({
      cfg,
      accountId: "default",
      inputs: ["U123"],
      kind: "user",
    } as never);

    expect(resolveTargetsWithOptionalTokenMock).toHaveBeenCalledTimes(1);
    const params = mockRecordArgAt(resolveTargetsWithOptionalTokenMock, 0, 0);
    expect(params.token).toBe("xoxb-bot");
    expect(params.inputs).toEqual(["U123"]);
    expect(params.missingTokenNote).toBe("missing Slack token");
    const resolveWithToken = params.resolveWithToken;
    if (typeof resolveWithToken !== "function") {
      throw new Error("expected Slack target resolver callback");
    }
    const mapResolved = params.mapResolved;
    if (typeof mapResolved !== "function") {
      throw new Error("expected Slack target mapper callback");
    }
    expect(
      mapResolved({
        input: "U123",
        resolved: true,
        id: "U123",
        name: "Ada",
        note: "workspace match",
      }),
    ).toEqual({
      input: "U123",
      resolved: true,
      id: "U123",
      name: "Ada",
      note: "workspace match",
    });
    expect(result).toBe(sentinelOutput);
  });

  it("prefers the user token over the bot token when both are configured", async () => {
    const resolveTargets = slackPlugin.resolver!.resolveTargets!;

    resolveTargetsWithOptionalTokenMock.mockResolvedValue([]);

    await resolveTargets({
      cfg: makeMinimalSlackConfig({ botToken: "xoxb-bot", userToken: "xoxp-user" }),
      accountId: "default",
      inputs: ["U1"],
      kind: "user",
    } as never);

    const params = mockRecordArgAt(resolveTargetsWithOptionalTokenMock, 0, 0);
    expect(params.token).toBe("xoxp-user");
  });

  it("uses the same lazy SDK helper for kind='group'", async () => {
    const resolveTargets = slackPlugin.resolver!.resolveTargets!;

    resolveTargetsWithOptionalTokenMock.mockResolvedValue([]);

    await resolveTargets({
      cfg: makeMinimalSlackConfig({ botToken: "xoxb-bot" }),
      accountId: "default",
      inputs: ["C1"],
      kind: "group",
    } as never);

    expect(resolveTargetsWithOptionalTokenMock).toHaveBeenCalledTimes(1);
    const params = mockRecordArgAt(resolveTargetsWithOptionalTokenMock, 0, 0);
    expect(params.token).toBe("xoxb-bot");
    expect(params.inputs).toEqual(["C1"]);
  });
});
