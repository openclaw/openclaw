import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../../test-support.js";

type GatewayAuth = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
  mutateConfigFile: vi.fn(async (params: { mutate: (draft: OpenClawConfig) => unknown }) => {
    const draft = structuredClone(mocks.getRuntimeConfig());
    await params.mutate(draft);
    await mocks.writeConfigFile(draft);
  }),
  resolveGatewayAuth: vi.fn(({ authConfig }: { authConfig?: GatewayAuth }) => {
    const token = typeof authConfig?.token === "string" ? authConfig.token : undefined;
    const password = typeof authConfig?.password === "string" ? authConfig.password : undefined;
    const mode = authConfig?.mode ?? (password ? "password" : "token");
    return { mode, token, password };
  }),
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
  mutateConfigFile: mocks.mutateConfigFile,
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  ensureGatewayStartupAuth: mocks.ensureGatewayStartupAuth,
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

function browserConfig(auth?: GatewayAuth): OpenClawConfig {
  return { browser: { enabled: true }, ...(auth ? gatewayConfig(auth) : {}) };
}

function gatewayConfig(auth: GatewayAuth): OpenClawConfig {
  const trustedProxy =
    auth.mode === "trusted-proxy" ? { userHeader: "x-forwarded-user" } : undefined;
  return {
    gateway: { auth: { ...(trustedProxy ? { trustedProxy } : {}), ...auth } },
  };
}

function expectNoAuthWrites() {
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
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
    Object.values(mocks).forEach((mock) => mock.mockClear());
  });

  it("returns existing auth and skips writes", async () => {
    const cfg = gatewayConfig({ token: "already-set" });
    expect(await ensureBrowserControlAuth({ cfg, env: {} })).toEqual({
      auth: { token: "already-set" },
    });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expectNoAuthWrites();
  });

  it.each([
    ["password", { password: "active-password" }],
    ["none", { token: "active-token" }],
    ["token", { token: "active-token" }],
    ["trusted-proxy", { password: "active-password" }],
  ] as const)("returns only the active credential in %s mode", (mode, expected) => {
    const cfg = gatewayConfig({ mode, token: "active-token", password: "active-password" });
    expect(resolveBrowserControlAuth(cfg, {})).toEqual(expected);
  });

  it("does not accept an inactive token in trusted-proxy mode", () => {
    const cfg = gatewayConfig({ mode: "trusted-proxy", token: "inactive-token" });
    expect(resolveBrowserControlAuth(cfg, {})).toEqual({});
  });

  it("auto-generates and persists a token when auth is missing", async () => {
    const cfg = browserConfig();
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    const result = await ensureBrowserControlAuth({ cfg, env: {} });
    await expectGeneratedTokenPersisted(result);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it.each<[string, OpenClawConfig, NodeJS.ProcessEnv]>([
    ["test env", browserConfig(), { NODE_ENV: "test" }],
    ["explicit password mode", browserConfig({ mode: "password" }), {}],
  ])("skips auto-generation for %s", async (_name, cfg, env) => {
    expect(await ensureBrowserControlAuth({ cfg, env })).toEqual({ auth: {} });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expectNoAuthWrites();
  });

  it.each([
    ["none", "token", "BROWSER_TOKEN"],
    ["trusted-proxy", "password", "BROWSER_PASSWORD"],
  ] as const)("does not overwrite unresolved %s %s SecretRefs", async (mode, field, id) => {
    const cfg = browserConfig({ mode, [field]: { source: "env", provider: "default", id } });
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    expect(await ensureBrowserControlAuth({ cfg, env: {} })).toEqual({ auth: {} });
    expectNoAuthWrites();
  });

  it("generates and persists a none-mode token despite an inactive password SecretRef", async () => {
    const cfg = browserConfig({
      mode: "none",
      password: { source: "env", provider: "default", id: "INACTIVE_SECRET" },
    });
    mocks.getRuntimeConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} });

    expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.auth).toEqual({ token: result.generatedToken });
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfigFile.mock.calls[0]![0].gateway?.auth).toMatchObject({
      mode: "none",
      token: result.generatedToken,
    });
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("keeps a trusted-proxy browser password in this process instead of gateway.auth", async () => {
    const cfg = browserConfig({
      mode: "trusted-proxy",
      token: { source: "env", provider: "default", id: "INACTIVE_SECRET" },
    });
    mocks.getRuntimeConfig.mockReturnValue(cfg);

    const first = await ensureBrowserControlAuth({ cfg, env: {} });
    const second = await ensureBrowserControlAuth({ cfg, env: {} });

    expect(first.auth.password).toMatch(/^[a-f0-9]{48}$/);
    expect(first.auth.token).toBeUndefined();
    expect(second).toEqual({ auth: first.auth });
    expect(mocks.mutateConfigFile).not.toHaveBeenCalled();
    expectNoAuthWrites();
  });

  it("reuses auth from latest config snapshot", async () => {
    const cfg = browserConfig();
    mocks.getRuntimeConfig.mockReturnValue(browserConfig({ token: "latest-token" }));

    expect(await ensureBrowserControlAuth({ cfg, env: {} })).toEqual({
      auth: { token: "latest-token" },
    });
    expectNoAuthWrites();
  });

  it.each(["generated", "replacement", "other-mode"] as const)(
    "rereads %s auth after generating for none mode",
    async (afterWrite) => {
      const cfg = gatewayConfig({ mode: "none" });
      let latest = cfg;
      let generated: string | undefined;
      mocks.getRuntimeConfig.mockImplementation(() => latest);
      mocks.writeConfigFile.mockImplementationOnce(async (written) => {
        const value = written.gateway?.auth?.token;
        if (typeof value !== "string") {
          throw new Error("expected a generated browser credential");
        }
        generated = value;
        latest =
          afterWrite === "generated"
            ? written
            : afterWrite === "replacement"
              ? gatewayConfig({ mode: "none", token: "concurrent-credential" })
              : gatewayConfig({ mode: "password", password: "concurrent-credential" });
      });

      const result = await ensureBrowserControlAuth({ cfg, env: {} });

      expect(generated).toMatch(/^[a-f0-9]{48}$/);
      expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
      expect(result).toEqual({
        auth:
          afterWrite === "replacement" || afterWrite === "other-mode"
            ? { [afterWrite === "other-mode" ? "password" : "token"]: "concurrent-credential" }
            : { token: generated },
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
