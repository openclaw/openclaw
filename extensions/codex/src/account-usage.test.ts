import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { withAuthProfileStoreAtEffect } from "openclaw/plugin-sdk/provider-auth-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexAccountUsage } from "./account-usage-runtime.js";
import { readCodexAppServerUsage } from "./app-server/request.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  withAuthProfileStoreAtEffect: vi.fn(),
}));
vi.mock("./app-server/request.js", () => ({ readCodexAppServerUsage: vi.fn() }));

function usage(usedPercent: number) {
  return {
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      },
    },
  };
}

describe("codex.accountUsage", () => {
  let config: OpenClawConfig;
  let store: AuthProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    config = { agents: { entries: { main: {}, work: {} } } };
    store = {
      version: 1,
      profiles: {
        "openai:alex": {
          type: "oauth",
          provider: "openai",
          access: "alex-access-placeholder",
          refresh: "alex-refresh-placeholder",
          expires: 1_900_000_000_000,
          accountId: "alex-account",
        },
        "openai:blair": { type: "token", provider: "openai", token: "blair-token-placeholder" },
        "openai:api": { type: "api_key", provider: "openai", key: "api-key-placeholder" },
      },
    };
    vi.mocked(withAuthProfileStoreAtEffect).mockImplementation(
      async (_agentDir, _options, consume) =>
        consume({ read: async () => store, assertCurrent() {} }),
    );
    vi.mocked(readCodexAppServerUsage).mockResolvedValue(usage(20));
  });

  async function request(params: Record<string, unknown>) {
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handleCodexAccountUsage({
      req: { type: "req", id: "usage-request", method: "codex.accountUsage", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
      hasCurrentClientAuthority: () => true,
    });
    return respond;
  }

  it("reads the selected account in an isolated subscription session", async () => {
    vi.mocked(readCodexAppServerUsage).mockImplementation(async (options) => {
      expect(options.startOptions).toMatchObject({ homeScope: "agent", transport: "stdio" });
      expect(options.authRequirement).toBe("subscription");
      expect(options.authProfileId).toBeUndefined();
      const prepared = options.preparedAuth;
      if (prepared?.kind !== "profile") {
        throw new Error("Selected account was not prepared");
      }
      expect(prepared.store).not.toBe(store);
      options.assertCurrent?.();
      return usage(prepared.profileId === "openai:alex" ? 11 : 72);
    });
    for (const [profileId, usedPercent] of [
      ["openai:alex", 11],
      ["openai:blair", 72],
    ] as const) {
      const respond = await request({ agentId: "work", profileId });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          providers: [
            expect.objectContaining({
              provider: "openai",
              windows: [{ label: "5h", usedPercent, resetAt: 1_800_000_000_000 }],
            }),
          ],
        }),
      );
    }
  });

  it("distinguishes reserve quota from ordinary Luna in selected-account usage", async () => {
    const ordinary = usage(100).rateLimits.rateLimits;
    vi.mocked(readCodexAppServerUsage).mockResolvedValue({
      rateLimits: {
        rateLimits: ordinary,
        rateLimitsByLimitId: {
          codex: ordinary,
          base_model_inference: {
            limitId: "base_model_inference",
            limitName: "gpt-reserve",
            normalModelSlug: "gpt-5.6-luna",
            secondary: { usedPercent: 0, windowDurationMins: 10_080 },
          },
        },
        ordinaryUsageAllowed: null,
        rateLimitUpsell: null,
      },
    });
    const respond = await request({ agentId: "work", profileId: "openai:alex" });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: [
          expect.objectContaining({
            summary: expect.stringContaining("Ordinary Luna does not use this reserve"),
            windows: expect.arrayContaining([
              expect.objectContaining({
                groupLabel: "Luna Reserve (separate route)",
                usedPercent: 0,
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it("rejects proxy launches before sending the selected account to a shared daemon", async () => {
    config.plugins = {
      entries: {
        codex: {
          config: { appServer: { args: ["app-server", "proxy", "--sock", "/tmp/codex.sock"] } },
        },
      },
    };
    const respond = await request({ agentId: "main", profileId: "openai:alex" });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("proxy") }),
    );
    expect(readCodexAppServerUsage).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "../main", profileId: "openai:alex" },
    { profileId: "openai:alex" },
    { agentId: "main", profileId: "openai:api" },
  ])("rejects an unavailable or invalid selection without fetching: %j", async (params) => {
    const respond = await request(params);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(readCodexAppServerUsage).not.toHaveBeenCalled();
  });
});
