import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../../test-support.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
  replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    await mocks.writeConfigFile(nextConfig);
  }),
  mutateConfigFile: vi.fn(
    async (params: {
      mutate: (draft: OpenClawConfig, context: { snapshot: { path: string } }) => unknown;
    }) => {
      const draft = structuredClone(mocks.getRuntimeConfig());
      const result = await params.mutate(draft, { snapshot: { path: "/tmp/openclaw.json" } });
      await mocks.writeConfigFile(draft);
      return {
        path: "/tmp/openclaw.json",
        previousHash: "test-hash",
        persistedHash: "test-hash",
        snapshot: { path: "/tmp/openclaw.json" },
        nextConfig: draft,
        result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
  ),
  resolveGatewayAuth: vi.fn(
    ({
      authConfig,
    }: {
      authConfig?: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;
    }) => {
      const token = typeof authConfig?.token === "string" ? authConfig.token : undefined;
      const password = typeof authConfig?.password === "string" ? authConfig.password : undefined;
      const mode = authConfig?.mode ?? (password ? "password" : "token");
      return { mode, token, password };
    },
  ),
  ensureGatewayStartupAuth: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => {
    const auth = { mode: "token" as const, token: "a".repeat(48) };
    return {
      cfg: { ...cfg, gateway: { ...cfg.gateway, auth: { ...cfg.gateway?.auth, ...auth } } },
      auth,
      generatedToken: auth.token,
      persistedGeneratedToken: true,
    };
  }),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("openclaw/plugin-sdk/config-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/config-mutation")>()),
  replaceConfigFile: mocks.replaceConfigFile,
  mutateConfigFile: mocks.mutateConfigFile,
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  ensureGatewayStartupAuth: mocks.ensureGatewayStartupAuth,
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

type GatewayAuth = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;

function browserConfig(auth?: GatewayAuth): OpenClawConfig {
  return { browser: { enabled: true }, ...(auth ? { gateway: { auth } } : {}) };
}

function expectNoAuthWrites() {
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
}

function readPersistedConfig(): OpenClawConfig {
  const persistedCfg = mocks.writeConfigFile.mock.calls[0]?.[0];
  if (!persistedCfg) {
    throw new Error("expected persisted config");
  }
  return persistedCfg;
}

async function expectGeneratedBrowserAuthPersistence(
  cfg: OpenClawConfig,
  mode: "none" | "trusted-proxy",
  field: "token" | "password",
) {
  mocks.getRuntimeConfig.mockReturnValue(cfg);

  const result = await ensureBrowserControlAuth({ cfg, env: {} });

  expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
  expect(result.auth[field]).toBe(result.generatedToken);
  expect(result.auth[field === "token" ? "password" : "token"]).toBeUndefined();
  expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
  const persistedCfg = readPersistedConfig();
  expect(persistedCfg.gateway?.auth).toMatchObject({ mode, [field]: result.generatedToken });
  expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
}

async function expectUnresolvedBrowserSecretRefSkipsPersistence(cfg: OpenClawConfig) {
  mocks.getRuntimeConfig.mockReturnValue(cfg);

  const result = await ensureBrowserControlAuth({ cfg, env: {} });

  expect(result).toEqual({ auth: {} });
  expectNoAuthWrites();
}

let ensureBrowserControlAuth: typeof import("./control-auth.js").ensureBrowserControlAuth;
let resolveBrowserControlAuth: typeof import("./control-auth.js").resolveBrowserControlAuth;

describe("ensureBrowserControlAuth", () => {
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
    ({ ensureBrowserControlAuth, resolveBrowserControlAuth } = await import("./control-auth.js"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getRuntimeConfig.mockClear();
    mocks.writeConfigFile.mockClear();
    mocks.mutateConfigFile.mockClear();
    mocks.resolveGatewayAuth.mockClear();
    mocks.ensureGatewayStartupAuth.mockClear();
  });

  it("returns existing auth and skips writes", async () => {
    const cfg: OpenClawConfig = { gateway: { auth: { token: "already-set" } } };

    const result = await ensureBrowserControlAuth({ cfg, env: {} });

    expect(result).toEqual({ auth: { token: "already-set" } });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expectNoAuthWrites();
  });

  it.each([
    ["password", { password: "active-password" }],
    ["none", { token: "active-token" }],
    ["token", { token: "active-token" }],
    ["trusted-proxy", { password: "active-password" }],
  ] as const)("returns only the active credential in %s mode", (mode, expected) => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode,
          token: "active-token",
          password: "active-password",
          ...(mode === "trusted-proxy" ? { trustedProxy: { userHeader: "x-forwarded-user" } } : {}),
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {})).toEqual(expected);
  });

  it("does not accept an inactive token in trusted-proxy mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          token: "inactive-token",
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {})).toEqual({});
  });

  it("auto-generates and persists a token when auth is missing", async () => {
    const cfg = browserConfig();
    mocks.getRuntimeConfig.mockReturnValue(browserConfig());

    const result = await ensureBrowserControlAuth({ cfg, env: {} });
    await expectGeneratedTokenPersisted(result);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("skips auto-generation in test env", async () => {
    const cfg = browserConfig();

    const result = await ensureBrowserControlAuth({
      cfg,
      env: { NODE_ENV: "test" },
    });

    expect(result).toEqual({ auth: {} });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expectNoAuthWrites();
  });

  it("respects explicit password mode", async () => {
    const cfg = browserConfig({ mode: "password" });
    const result = await ensureBrowserControlAuth({ cfg, env: {} });
    expect(result).toEqual({ auth: {} });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expectNoAuthWrites();
  });

  it.each([
    ["none", "token", "BROWSER_TOKEN"],
    ["trusted-proxy", "password", "BROWSER_PASSWORD"],
  ] as const)("does not overwrite unresolved %s %s SecretRefs", async (mode, field, id) => {
    await expectUnresolvedBrowserSecretRefSkipsPersistence(
      browserConfig({
        mode,
        [field]: { source: "env", provider: "default", id },
        ...(mode === "trusted-proxy" ? { trustedProxy: { userHeader: "x-forwarded-user" } } : {}),
      }),
    );
  });

  it("still auto-generates in none mode when only password SecretRef is set", async () => {
    const cfg = browserConfig({
      mode: "none",
      password: { source: "env", provider: "default", id: "INACTIVE_PASSWORD" },
    });
    await expectGeneratedBrowserAuthPersistence(cfg, "none", "token");
  });
  it("still auto-generates in trusted-proxy mode when only token SecretRef is set", async () => {
    const cfg = browserConfig({
      mode: "trusted-proxy",
      token: { source: "env", provider: "default", id: "INACTIVE_TOKEN" },
      trustedProxy: { userHeader: "x-forwarded-user" },
    });
    await expectGeneratedBrowserAuthPersistence(cfg, "trusted-proxy", "password");
  });

  it("reuses auth from latest config snapshot", async () => {
    const cfg = browserConfig();
    mocks.getRuntimeConfig.mockReturnValue(browserConfig({ token: "latest-token" }));

    const result = await ensureBrowserControlAuth({ cfg, env: {} });

    expect(result).toEqual({ auth: { token: "latest-token" } });
    expectNoAuthWrites();
  });

  it.each([
    { mode: "none", afterWrite: "generated" },
    { mode: "none", afterWrite: "replacement" },
    { mode: "none", afterWrite: "other-mode" },
    { mode: "trusted-proxy", afterWrite: "generated" },
  ] as const)(
    "rereads $afterWrite auth after generating for $mode",
    async ({ mode, afterWrite }) => {
      const kind = mode === "none" ? "token" : "password";
      const otherKind = kind === "token" ? "password" : "token";
      const cfg: OpenClawConfig = { gateway: { auth: { mode } } };
      let latest = cfg;
      let generated: string | undefined;
      mocks.getRuntimeConfig.mockImplementation(() => latest);
      mocks.writeConfigFile.mockImplementationOnce(async (written) => {
        const value = written.gateway?.auth?.[kind];
        if (typeof value !== "string") {
          throw new Error("expected a generated browser credential");
        }
        generated = value;
        latest =
          afterWrite === "generated"
            ? written
            : afterWrite === "replacement"
              ? { gateway: { auth: { mode, [kind]: "concurrent-credential" } } }
              : { gateway: { auth: { mode: otherKind, [otherKind]: "concurrent-credential" } } };
      });

      const result = await ensureBrowserControlAuth({ cfg, env: {} });

      expect(generated).toMatch(/^[a-f0-9]{48}$/);
      expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
      expect(result).toEqual({
        auth:
          afterWrite === "replacement" || afterWrite === "other-mode"
            ? { [afterWrite === "other-mode" ? otherKind : kind]: "concurrent-credential" }
            : { [kind]: generated },
        generatedToken: afterWrite === "generated" ? generated : undefined,
      });
    },
  );

  it("fails when gateway.auth.token SecretRef is unresolved", async () => {
    const cfg: OpenClawConfig = {
      ...browserConfig({
        mode: "token",
        token: { source: "env", provider: "default", id: "MISSING_GW_TOKEN" },
      }),
      secrets: { providers: { default: { source: "env" } } },
    };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.ensureGatewayStartupAuth.mockRejectedValueOnce(new Error("MISSING_GW_TOKEN"));

    await expect(ensureBrowserControlAuth({ cfg, env: {} })).rejects.toThrow(/MISSING_GW_TOKEN/i);
    expect(mocks.ensureGatewayStartupAuth).toHaveBeenCalledTimes(1);
  });
});
