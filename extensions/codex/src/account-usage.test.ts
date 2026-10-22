import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { withAuthProfileStoreAtEffect } from "openclaw/plugin-sdk/provider-auth-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { handleCodexAccountUsage } from "./account-usage-runtime.js";
import { readCodexAppServerUsage } from "./app-server/request.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  withAuthProfileStoreAtEffect: vi.fn(),
}));
vi.mock("./app-server/request.js", () => ({ readCodexAppServerUsage: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  const store: AuthProfileStore = {
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
  vi.mocked(withAuthProfileStoreAtEffect).mockImplementation(async (_agentDir, _options, consume) =>
    consume({ read: async () => store, assertCurrent() {} }),
  );
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
    return {
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          planType: "pro",
          primary: {
            usedPercent: prepared.profileId === "openai:alex" ? 11 : 72,
            windowDurationMins: 300,
            resetsAt: 1_800_000_000,
          },
        },
      },
    };
  });
});

it.each<{
  agentId?: string;
  profileId: string;
  usedPercent?: number;
  proxy?: boolean;
}>([
  { agentId: "work", profileId: "openai:alex", usedPercent: 11 },
  { agentId: "work", profileId: "openai:blair", usedPercent: 72 },
  { agentId: "../main", profileId: "openai:alex" },
  { profileId: "openai:alex" },
  { agentId: "main", profileId: "openai:api" },
  { agentId: "main", profileId: "openai:alex", proxy: true },
])("isolates or rejects selected-account usage: %j", async ({ usedPercent, proxy, ...params }) => {
  const config: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };
  if (proxy) {
    config.plugins = {
      entries: {
        codex: {
          config: {
            appServer: { args: ["app-server", "proxy", "--sock", "/tmp/codex.sock"] },
          },
        },
      },
    };
  }
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
  if (usedPercent === undefined) {
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining(
        proxy
          ? { code: "UNAVAILABLE", message: expect.stringContaining("proxy") }
          : { code: expect.any(String) },
      ),
    );
    expect(readCodexAppServerUsage).not.toHaveBeenCalled();
  } else {
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
