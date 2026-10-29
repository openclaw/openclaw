import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/target-resolver-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";

const mocks = vi.hoisted(() => ({
  scopes: vi.fn(),
  targets: vi.fn<typeof resolveTargetsWithOptionalToken>(),
  summary: vi.fn(),
}));
vi.mock("./scopes.js", () => ({ fetchSlackScopes: mocks.scopes }));
vi.mock("openclaw/plugin-sdk/target-resolver-runtime", async (orig) => ({
  ...(await orig<typeof import("openclaw/plugin-sdk/target-resolver-runtime")>()),
  resolveTargetsWithOptionalToken: mocks.targets,
}));
vi.mock("openclaw/plugin-sdk/extension-shared", async (orig) => ({
  ...(await orig<typeof import("openclaw/plugin-sdk/extension-shared")>()),
  buildPassiveProbedChannelStatusSummary: mocks.summary,
}));

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

function accountContext(tokens: { botToken?: string; userToken?: string }) {
  const cfg: OpenClawConfig = { channels: { slack: tokens } };
  return { cfg, account: slackPlugin.config.resolveAccount(cfg, "default") };
}

it.each([true, false])("summarizes token sources when configured=%s", async (configured) => {
  const sources = { botTokenSource: "config", appTokenSource: "config" } as const;
  const snapshot = { accountId: "default", configured, ...(configured ? sources : {}) };
  const summary = { configured: true };
  mocks.summary.mockReturnValue(summary);
  expect(
    await slackPlugin.status!.buildChannelSummary!({
      snapshot,
      defaultAccountId: "default",
      ...accountContext({ botToken: "xoxb-bot" }),
    }),
  ).toBe(summary);
  expect(mocks.summary).toHaveBeenCalledExactlyOnceWith(snapshot, {
    botTokenSource: configured ? "config" : "none",
    appTokenSource: configured ? "config" : "none",
  });
});

it.each([
  { tokens: { botToken: "xoxb-bot", userToken: "xoxp-user" }, present: true },
  { tokens: {}, present: false },
])("reports scopes with tokens present=$present", async ({ tokens, present }) => {
  const botScopes = { ok: true, scopes: ["chat:write"] };
  const userScopes = { ok: true, scopes: ["users:read"] };
  mocks.scopes.mockResolvedValueOnce(botScopes).mockResolvedValueOnce(userScopes);
  const result = await slackPlugin.status!.buildCapabilitiesDiagnostics!({
    ...accountContext(tokens),
    timeoutMs: 5000,
  });
  const calls = ["xoxb-bot", "xoxp-user"].map((token) => [token, 5000]);
  expect(mocks.scopes.mock.calls).toEqual(present ? calls : []);
  expect(result?.details).toEqual(
    present
      ? { botScopes, userScopes }
      : { botScopes: { ok: false, error: "Slack bot token missing." } },
  );
});

it.each(["user", "group"] as const)("resolves %s targets with selected token", async (kind) => {
  const { cfg } = accountContext({
    botToken: "xoxb-bot",
    ...(kind === "user" ? { userToken: "xoxp-user" } : {}),
  });
  const resolved = [{ input: "U123", resolved: true, id: "U123", name: "A", note: "n" }];
  mocks.targets.mockResolvedValue(resolved);
  expect(
    await slackPlugin.resolver!.resolveTargets!({
      cfg,
      accountId: "default",
      inputs: ["U123"],
      kind,
      runtime: createRuntimeEnv(),
    }),
  ).toBe(resolved);
  expect(mocks.targets).toHaveBeenCalledOnce();
  const params = mocks.targets.mock.calls[0]![0];
  expect(params).toMatchObject({
    token: kind === "user" ? "xoxp-user" : "xoxb-bot",
    inputs: ["U123"],
    missingTokenNote: "missing Slack token",
    resolveWithToken: expect.any(Function),
    mapResolved: expect.any(Function),
  });
  expect(params.mapResolved(resolved[0])).toEqual(resolved[0]);
});
