import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCodexAccountUsage } from "./account-usage.js";
import { resolveCodexAppServerAuthProfileStore } from "./app-server/auth-profile.js";
import { readCodexAppServerUsage } from "./app-server/request.js";

vi.mock("./app-server/auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileStore: vi.fn(),
}));
vi.mock("./app-server/request.js", () => ({ readCodexAppServerUsage: vi.fn() }));

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

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
  let handler: Handler;
  let currentAuthority: boolean;
  const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();

  beforeEach(() => {
    vi.clearAllMocks();
    config = { agents: { list: [{ id: "main" }, { id: "work" }] } };
    currentAuthority = true;
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
        "anthropic:work": { type: "token", provider: "anthropic", token: "anthropic-placeholder" },
      },
    };
    vi.mocked(resolveCodexAppServerAuthProfileStore).mockImplementation(() => store);
    vi.mocked(readCodexAppServerUsage).mockResolvedValue(usage(20));
    registerGatewayMethod.mockImplementation((_method, registered) => {
      handler = registered;
    });
    registerCodexAccountUsage(createTestPluginApi({ config, registerGatewayMethod }));
  });

  async function request(params: Record<string, unknown>) {
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handler({
      req: { type: "req", id: "usage-request", method: "codex.accountUsage", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { getRuntimeConfig: () => config } as GatewayRequestHandlerOptions["context"],
      hasCurrentClientAuthority: () => currentAuthority,
    });
    return respond;
  }

  it("requires administrator scope and reads the selected account in an isolated subscription session", async () => {
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "codex.accountUsage",
      expect.any(Function),
      expect.objectContaining({ scope: "operator.admin" }),
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
    expect(resolveCodexAppServerAuthProfileStore).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: expect.stringContaining("work") }),
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
    { agentId: "missing", profileId: "openai:alex" },
    { agentId: "../main", profileId: "openai:alex" },
    { profileId: "openai:alex" },
    { agentId: "main", profileId: "" },
    { agentId: "main", profileId: "openai:missing" },
    { agentId: "main", profileId: "openai:api" },
    { agentId: "main", profileId: "anthropic:work" },
    { agentId: "main", profileId: "openai:alex", refresh: true },
  ])("rejects an unavailable or invalid selection without fetching: %j", async (params) => {
    const respond = await request(params);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(readCodexAppServerUsage).not.toHaveBeenCalled();
  });

  it.each(["removed", "replaced", "config changed", "authority revoked"])(
    "rejects guarded work and discards its result when %s during a read",
    async (change) => {
      let assertCurrent: (() => void) | undefined;
      vi.mocked(readCodexAppServerUsage).mockImplementation(async (options) => {
        assertCurrent = options.assertCurrent;
        if (change === "removed") {
          delete store.profiles["openai:alex"];
        } else if (change === "replaced") {
          store.profiles["openai:alex"] = {
            type: "token",
            provider: "openai",
            token: "replacement-placeholder",
          };
        } else if (change === "config changed") {
          config = structuredClone(config);
        } else {
          currentAuthority = false;
        }
        return usage(99);
      });
      const respond = await request({ agentId: "main", profileId: "openai:alex" });
      expect(assertCurrent).toBeTypeOf("function");
      expect(() => assertCurrent?.()).toThrow();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(respond).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts an OAuth refresh that updates both the selected store and its live owner", async () => {
    vi.mocked(readCodexAppServerUsage).mockImplementation(async (options) => {
      const prepared = options.preparedAuth;
      if (prepared?.kind !== "profile") {
        throw new Error("Selected account was not prepared");
      }
      const credential = prepared.store.profiles[prepared.profileId];
      if (credential?.type !== "oauth") {
        throw new Error("Expected OAuth account");
      }
      const refreshed = { ...credential, access: "rotated-access-placeholder" };
      prepared.store.profiles[prepared.profileId] = refreshed;
      store.profiles[prepared.profileId] = refreshed;
      options.assertCurrent?.();
      return usage(21);
    });
    const respond = await request({ agentId: "main", profileId: "openai:alex" });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: [
          expect.objectContaining({ windows: [expect.objectContaining({ usedPercent: 21 })] }),
        ],
      }),
    );
  });

  it("returns an unavailable result when the upstream reader fails", async () => {
    vi.mocked(readCodexAppServerUsage).mockRejectedValue(new Error("Codex service unavailable"));
    const respond = await request({ agentId: "main", profileId: "openai:alex" });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(respond).toHaveBeenCalledTimes(1);
  });
});
