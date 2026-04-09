import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../../test-support.js";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(),
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
  resolveGatewayAuth: vi.fn(
    ({
      authConfig,
    }: {
      authConfig?: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]> | undefined;
    }) => {
      const token =
        typeof authConfig?.token === "string"
          ? authConfig.token
          : typeof authConfig?.token === "object"
            ? undefined
            : undefined;
      const password = typeof authConfig?.password === "string" ? authConfig.password : undefined;
      return {
        token,
        password,
      };
    },
  ),
  ensureGatewayStartupAuth: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
    cfg: {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: "token" as const,
          token: "a".repeat(48),
        },
      },
    },
    auth: {
      mode: "token" as const,
      token: "a".repeat(48),
    },
    generatedToken: "a".repeat(48),
    persistedGeneratedToken: true,
  })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../gateway/startup-auth.js", () => ({
  ensureGatewayStartupAuth: mocks.ensureGatewayStartupAuth,
}));

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

let ensureBrowserControlAuth: typeof import("./control-auth.js").ensureBrowserControlAuth;

describe("ensureBrowserControlAuth", () => {
  const expectExplicitModeSkipsAutoAuth = async (mode: "password") => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode },
      },
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });
    expect(result).toEqual({ auth: {} });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  };

  const expectGeneratedTokenPersisted = async (result: {
    generatedToken?: string;
    auth: { token?: string };
  }) => {
    expect(mocks.ensureGatewayStartupAuth).toHaveBeenCalledTimes(1);
    const ensured = await mocks.ensureGatewayStartupAuth.mock.results[0]?.value;
    expectGeneratedTokenPersistedToGatewayAuth({
      generatedToken: result.generatedToken,
      authToken: result.auth.token,
      persistedConfig: ensured?.cfg,
    });
  };

  beforeAll(async () => {
    ({ ensureBrowserControlAuth } = await import("./control-auth.js"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.writeConfigFile.mockClear();
    mocks.resolveGatewayAuth.mockClear();
    mocks.ensureGatewayStartupAuth.mockClear();
  });

  it("returns existing auth and skips writes", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "already-set",
        },
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: { token: "already-set" } });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("auto-generates and persists a token when auth is missing", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue({
      browser: {
        enabled: true,
      },
    });

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });
    await expectGeneratedTokenPersisted(result);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("skips auto-generation in test env", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({
      cfg,
      env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({ auth: {} });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("respects explicit password mode", async () => {
    await expectExplicitModeSkipsAutoAuth("password");
  });

  it("auto-generates and persists browser auth token in none mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "none" },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.auth.token).toBe(result.generatedToken);
    expect(result.auth.password).toBeUndefined();
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const persistedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig | undefined;
    expect(persistedCfg?.gateway?.auth?.mode).toBe("none");
    expect(persistedCfg?.gateway?.auth?.token).toBe(result.generatedToken);
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("does not persist over unresolved token SecretRef in none mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "none",
          token: { source: "env", provider: "default", id: "BROWSER_TOKEN" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: {} });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("still auto-generates in none mode when only password SecretRef is set", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "none",
          password: { source: "env", provider: "default", id: "INACTIVE_PASSWORD" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.auth.token).toBe(result.generatedToken);
    expect(result.auth.password).toBeUndefined();
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const persistedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig | undefined;
    expect(persistedCfg?.gateway?.auth?.mode).toBe("none");
    expect(persistedCfg?.gateway?.auth?.token).toBe(result.generatedToken);
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("auto-generates in trusted-proxy mode and persists browser auth password", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.auth.password).toBe(result.generatedToken);
    expect(result.auth.token).toBeUndefined();
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const persistedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig | undefined;
    expect(persistedCfg?.gateway?.auth?.mode).toBe("trusted-proxy");
    expect(persistedCfg?.gateway?.auth?.password).toBe(result.generatedToken);
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("still auto-generates in trusted-proxy mode when only token SecretRef is set", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          token: { source: "env", provider: "default", id: "INACTIVE_TOKEN" },
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.auth.password).toBe(result.generatedToken);
    expect(result.auth.token).toBeUndefined();
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const persistedCfg = mocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig | undefined;
    expect(persistedCfg?.gateway?.auth?.mode).toBe("trusted-proxy");
    expect(persistedCfg?.gateway?.auth?.password).toBe(result.generatedToken);
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("does not persist over unresolved password SecretRef in trusted-proxy mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "BROWSER_PASSWORD" },
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: {} });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("reuses auth from latest config snapshot", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "latest-token",
        },
      },
      browser: {
        enabled: true,
      },
    });

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: { token: "latest-token" } });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("fails when gateway.auth.token SecretRef is unresolved", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GW_TOKEN" },
        },
      },
      browser: {
        enabled: true,
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);
    mocks.ensureGatewayStartupAuth.mockRejectedValueOnce(new Error("MISSING_GW_TOKEN"));

    await expect(ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /MISSING_GW_TOKEN/i,
    );
    expect(mocks.ensureGatewayStartupAuth).toHaveBeenCalledTimes(1);
  });
});
