import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { setSlackRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  scopes: vi.fn(),
  targets: vi.fn(),
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
  setSlackRuntime({ channel: { slack: {} } } as never);
});

function config(tokens: { botToken?: string; userToken?: string } = {}): OpenClawConfig {
  return { channels: { slack: tokens } };
}

describe("Slack lazy channel surfaces", () => {
  it.each([true, false])("summarizes token sources when configured=%s", async (configured) => {
    const snapshot = {
      accountId: "default",
      configured,
      ...(configured
        ? { botTokenSource: "config" as const, appTokenSource: "config" as const }
        : {}),
    };
    const summary = { configured: true };
    mocks.summary.mockReturnValue(summary);
    const cfg = config({ botToken: "xoxb-bot" });
    expect(
      await slackPlugin.status!.buildChannelSummary!({
        snapshot,
        cfg,
        defaultAccountId: "default",
        account: slackPlugin.config.resolveAccount(cfg, "default"),
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
    const cfg = config(tokens);
    const botScopes = { ok: true, scopes: ["chat:write"] };
    const userScopes = { ok: true, scopes: ["users:read"] };
    mocks.scopes.mockResolvedValueOnce(botScopes).mockResolvedValueOnce(userScopes);
    const result = await slackPlugin.status!.buildCapabilitiesDiagnostics!({
      cfg,
      account: slackPlugin.config.resolveAccount(cfg, "default"),
      timeoutMs: 5000,
    });
    expect(mocks.scopes.mock.calls).toEqual(
      present
        ? [
            ["xoxb-bot", 5000],
            ["xoxp-user", 5000],
          ]
        : [],
    );
    expect(result?.details).toEqual(
      present
        ? { botScopes, userScopes }
        : {
            botScopes: { ok: false, error: "Slack bot token missing." },
          },
    );
  });

  it.each(["user", "group"] as const)(
    "resolves %s targets with the selected token",
    async (kind) => {
      const cfg = config({
        botToken: "xoxb-bot",
        ...(kind === "user" ? { userToken: "xoxp-user" } : {}),
      });
      const resolved = [
        { input: "U123", resolved: true, id: "U123", name: "Ada", note: "workspace match" },
      ];
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
      expect(mocks.targets).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          token: kind === "user" ? "xoxp-user" : "xoxb-bot",
          inputs: ["U123"],
          missingTokenNote: "missing Slack token",
          resolveWithToken: expect.any(Function),
          mapResolved: expect.any(Function),
        }),
      );
      if (kind === "user") {
        const params: unknown = mocks.targets.mock.calls[0]?.[0];
        expect(params).toHaveProperty("mapResolved");
        if (
          !params ||
          typeof params !== "object" ||
          !("mapResolved" in params) ||
          typeof params.mapResolved !== "function"
        ) {
          throw new Error("Expected Slack target mapper");
        }
        expect(params.mapResolved(resolved[0])).toEqual(resolved[0]);
      }
    },
  );
});
