import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import {
  resolveMatrixConfigForAccount,
  resolveMatrixAuthContext,
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} from "./config.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

function matrixConfig(matrix: MatrixConfig): CoreConfig {
  return { channels: { matrix } };
}

function resolveDefaultMatrixAuthContext(
  cfg: CoreConfig,
  env: NodeJS.ProcessEnv = {},
  accountId?: string,
) {
  return resolveMatrixAuthContext({ cfg, env, accountId });
}

const configAuth = {
  homeserver: "https://cfg.example.org",
  userId: "@cfg:example.org",
  accessToken: "cfg-token",
  password: "cfg-pass",
  deviceName: "CfgDevice",
  initialSyncLimit: 5,
};
const envAuth = {
  MATRIX_HOMESERVER: "https://env.example.org",
  MATRIX_USER_ID: "@env:example.org",
  MATRIX_ACCESS_TOKEN: "env-token",
  MATRIX_PASSWORD: "env-pass",
  MATRIX_DEVICE_NAME: "EnvDevice",
};
const opsAccount = { homeserver: "https://ops.example.org", accessToken: "ops-token" };

beforeEach(() => {
  installMatrixTestRuntime();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function createEnvSecretRefConfig(params: {
  field: "accessToken" | "password";
  provider?: string;
  secrets?: CoreConfig["secrets"];
}): CoreConfig {
  const account = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    [params.field]: {
      source: "env",
      provider: params.provider ?? "default",
      id: "MATRIX_TEST_SECRET",
    },
  };
  return {
    ...matrixConfig(account),
    secrets: params.secrets,
  };
}

describe("Matrix auth/config live surfaces", () => {
  it("prefers config over env", () => {
    const cfg = matrixConfig({ ...configAuth });
    expect(resolveDefaultMatrixAuthContext(cfg, envAuth).resolved).toEqual({
      ...configAuth,
      deviceId: undefined,
      encryption: false,
    });
  });

  it("uses env when config is missing", () => {
    expect(
      resolveDefaultMatrixAuthContext({}, { ...envAuth, MATRIX_DEVICE_ID: "ENVDEVICE" }).resolved,
    ).toEqual({
      homeserver: "https://env.example.org",
      userId: "@env:example.org",
      accessToken: "env-token",
      password: "env-pass",
      deviceId: "ENVDEVICE",
      deviceName: "EnvDevice",
      initialSyncLimit: undefined,
      encryption: false,
    });
  });

  it("resolves password from supplied env with a default alias declared as exec", () => {
    const cfg = createEnvSecretRefConfig({
      field: "password",
      provider: "shared",
      secrets: {
        defaults: { env: "shared" },
        providers: { shared: { source: "exec", command: "/unused/matrix-secret-command" } },
      },
    });
    expect(
      resolveDefaultMatrixAuthContext(cfg, { MATRIX_TEST_SECRET: " supplied-secret " }, "default")
        .resolved.password,
    ).toBe("supplied-secret");
  });

  it("does not resolve account password SecretRefs when scoped token auth is configured", () => {
    const cfg = matrixConfig({
      accounts: {
        ops: {
          homeserver: "https://ops.example.org",
          password: { source: "env", provider: "default", id: "MATRIX_OPS_PASSWORD" },
        },
      },
    });
    cfg.secrets = { providers: { default: { source: "env", allowlist: [] } } };
    expect(
      resolveMatrixConfigForAccount(cfg, "ops", { MATRIX_OPS_ACCESS_TOKEN: "ops-token" }),
    ).toMatchObject({ accessToken: "ops-token", password: undefined });
  });

  it("rejects accessToken SecretRefs with a missing env value", () => {
    vi.stubEnv("MATRIX_ACCESS_TOKEN", "ambient-token");
    vi.stubEnv("MATRIX_PASSWORD", "ambient-password");
    vi.stubEnv("MATRIX_TEST_SECRET", "ambient-secret");
    const cfg = createEnvSecretRefConfig({ field: "accessToken" });
    expect(() =>
      resolveDefaultMatrixAuthContext(cfg, {
        MATRIX_TEST_SECRET: undefined,
        MATRIX_ACCESS_TOKEN: "fallback-token",
      }),
    ).toThrow('channels.matrix.accessToken: unresolved SecretRef "env:default:MATRIX_TEST_SECRET"');
  });

  it.each([
    [["MATRIX_TEST_SECRET"], true],
    [[], false],
  ] as const)("honors explicit env allowlist %j (allowed: %s)", (allowlist, allowed) => {
    const cfg = createEnvSecretRefConfig({
      field: "password",
      provider: "shared",
      secrets: {
        defaults: { env: "shared" },
        providers: { shared: { source: "env", allowlist: [...allowlist] } },
      },
    });
    const resolve = () =>
      resolveDefaultMatrixAuthContext(cfg, { MATRIX_TEST_SECRET: "env-secret" });

    if (allowed) {
      expect(resolve().resolved.password).toBe("env-secret");
    } else {
      expect(resolve).toThrow("not allowlisted in secrets.providers.shared.allowlist");
    }
  });

  it.each([{ source: "file", path: "/unused/matrix-secret.json" }, undefined] as const)(
    "rejects non-default alias with declaration %j",
    (declaration) => {
      const cfg = createEnvSecretRefConfig({
        field: "accessToken",
        provider: "other",
        secrets: {
          providers: declaration ? { other: declaration } : undefined,
        },
      });

      expect(() =>
        resolveDefaultMatrixAuthContext(cfg, { MATRIX_TEST_SECRET: "env-secret" }),
      ).toThrow(
        declaration
          ? 'Secret provider "other" has source "file" but ref requests "env".'
          : 'Secret provider "other" is not configured (ref: env:other:MATRIX_TEST_SECRET).',
      );
    },
  );

  it("leaves non-env SecretRef access tokens unresolved", () => {
    const cfg = matrixConfig({
      homeserver: "https://cfg.example.org",
      accessToken: { source: "file", provider: "matrix-file", id: "value" },
    });
    cfg.secrets = { providers: { "matrix-file": { source: "file", path: "/tmp/matrix-token" } } };
    expect(resolveDefaultMatrixAuthContext(cfg).resolved.accessToken).toBeUndefined();
  });

  it("uses collision-free scoped env var names for normalized account ids", () => {
    expect(
      ["ops-prod", "ops_prod"].map((id) => getMatrixScopedEnvVarNames(id).accessToken),
    ).toEqual(["MATRIX_OPS_X2D_PROD_ACCESS_TOKEN", "MATRIX_OPS_X5F_PROD_ACCESS_TOKEN"]);
  });

  it("prefers channels.matrix.accounts.default over global env for the default account", () => {
    const account = {
      homeserver: "https://matrix.gumadeiras.com",
      userId: "@pinguini:matrix.gumadeiras.com",
      password: "cfg-pass", // pragma: allowlist secret
      deviceName: "OpenClaw Gateway Pinguini",
      encryption: true,
    };
    const { MATRIX_ACCESS_TOKEN: _unusedToken, ...env } = envAuth;
    const resolved = resolveDefaultMatrixAuthContext(
      matrixConfig({ accounts: { default: { ...account } } }),
      env,
    );
    expect(resolved.accountId).toBe("default");
    expect(resolved.resolved).toEqual({
      ...account,
      accessToken: undefined,
      deviceId: undefined,
      initialSyncLimit: undefined,
      allowPrivateNetwork: undefined,
      ssrfPolicy: undefined,
      dispatcherPolicy: undefined,
    });
  });

  it("ignores typoed defaultAccount values that do not map to a real Matrix account", () => {
    const cfg = matrixConfig({
      defaultAccount: "ops",
      homeserver: "https://legacy.example.org",
      accessToken: "legacy-token",
    });

    expect(resolveDefaultMatrixAuthContext(cfg).accountId).toBe("default");
  });

  it("requires explicit defaultAccount selection when multiple named Matrix accounts exist", () => {
    const cfg = matrixConfig({
      accounts: {
        assistant: {
          homeserver: "https://matrix.assistant.example.org",
          accessToken: "assistant-token",
        },
        ops: opsAccount,
      },
    });

    expect(() => resolveDefaultMatrixAuthContext(cfg)).toThrow(
      /channels\.matrix\.defaultAccount.*--account <id>/i,
    );
  });

  it('uses the injected env-backed "default" Matrix account when implicit selection is available', () => {
    const cfg = matrixConfig({});
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_ACCESS_TOKEN: "default-token",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    };

    expect(resolveDefaultMatrixAuthContext(cfg, env).accountId).toBe("default");
  });

  it("keeps implicit selection for env-backed accounts that can use cached credentials", () => {
    expect(
      resolveDefaultMatrixAuthContext(matrixConfig({ homeserver: "https://matrix.example.org" }), {
        MATRIX_OPS_USER_ID: "@ops:example.org",
      }).accountId,
    ).toBe("ops");
  });

  it.each([
    ["typo", /Matrix account "typo" is not configured/i],
    ["!!!", /Matrix account id "!!!" is invalid/i],
  ] as const)(
    "rejects explicit account %s instead of borrowing the default",
    (accountId, error) => {
      const cfg = matrixConfig({
        homeserver: "https://legacy.example.org",
        accessToken: "legacy-token",
        accounts: { ops: opsAccount },
      });
      expect(() => resolveDefaultMatrixAuthContext(cfg, {}, accountId)).toThrow(error);
    },
  );

  it.each(["channel", "account"])(
    "rejects a disabled %s before resolving secrets",
    (disabledScope) => {
      const cfg = matrixConfig({
        enabled: disabledScope !== "channel",
        homeserver: "https://legacy.example.org",
        accessToken: "legacy-token",
        accounts: {
          disabled: {
            enabled: disabledScope !== "account",
            homeserver: "https://disabled.example.org",
            accessToken: {
              source: "env",
              provider: "default",
              id: "MATRIX_DISABLED_ACCESS_TOKEN",
            },
          },
        },
      });

      expect(() => resolveDefaultMatrixAuthContext(cfg, {}, "disabled")).toThrow(
        /Matrix account "disabled" is disabled/i,
      );
    },
  );

  it.each([
    { field: "userId", account: opsAccount, expected: { userId: "" } },
    {
      field: "auth secrets",
      account: {
        homeserver: opsAccount.homeserver,
        userId: "@ops:example.org",
        password: "ops-pass", // pragma: allowlist secret
      },
      expected: { accessToken: undefined, password: "ops-pass", deviceId: undefined },
    },
    {
      field: "password",
      account: { homeserver: opsAccount.homeserver, userId: "@ops:example.org" },
      expected: { password: undefined },
    },
  ])("does not inherit base or global $field for non-default accounts", ({ account, expected }) => {
    const cfg = matrixConfig({
      homeserver: "https://base.example.org",
      userId: "@base:example.org",
      accessToken: "base-token",
      password: "base-pass", // pragma: allowlist secret
      deviceId: "BASEDEVICE",
      accounts: { ops: account },
    });
    const env = {
      MATRIX_ACCESS_TOKEN: "global-token",
      MATRIX_PASSWORD: "global-pass",
      MATRIX_DEVICE_ID: "GLOBALDEVICE",
    };

    expect(resolveMatrixConfigForAccount(cfg, "ops", env)).toMatchObject(expected);
  });

  it("accepts internal http homeservers only when private-network access is enabled", () => {
    expect(() => validateMatrixHomeserverUrl("http://matrix-synapse:8008")).toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
    expect(
      validateMatrixHomeserverUrl("http://matrix-synapse:8008", {
        allowPrivateNetwork: true,
      }),
    ).toBe("http://matrix-synapse:8008");
  });

  it("resolves an explicit proxy dispatcher from top-level Matrix config", () => {
    const cfg = matrixConfig({
      homeserver: "https://matrix.example.org",
      accessToken: "tok-123",
      proxy: "http://127.0.0.1:7890",
    });

    const resolved = resolveDefaultMatrixAuthContext(cfg).resolved;

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:7890",
    });
  });

  it("rejects public http homeservers even when private-network access is enabled", async () => {
    await expect(
      resolveValidatedMatrixHomeserverUrl("http://matrix.example.org:8008", {
        allowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
  });

  it("accepts internal http hostnames when the private-network opt-in is explicit", async () => {
    await expect(
      resolveValidatedMatrixHomeserverUrl("http://localhost.localdomain:8008", {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).resolves.toBe("http://localhost.localdomain:8008");
  });
});
