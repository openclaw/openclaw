import http from "node:http";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import {
  createMatrixMonitorTaskRunner,
  getMatrixMonitorTaskSignal,
} from "../monitor/task-runner.js";
import { probeMatrix } from "../probe.js";
import {
  backfillMatrixAuthDeviceIdAfterStartup,
  resolveMatrixAuth,
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

function secretConfig(
  field: "accessToken" | "password",
  provider = "default",
  secrets?: CoreConfig["secrets"],
): CoreConfig {
  return {
    ...matrixConfig({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      [field]: { source: "env", provider, id: "MATRIX_TEST_SECRET" },
    }),
    secrets,
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
    const cfg = secretConfig("password", "shared", {
      defaults: { env: "shared" },
      providers: { shared: { source: "exec", command: "/unused/matrix-secret-command" } },
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
      resolveMatrixAuthContext({
        cfg,
        accountId: "ops",
        env: { MATRIX_OPS_ACCESS_TOKEN: "ops-token" },
      }).resolved,
    ).toMatchObject({ accessToken: "ops-token", password: undefined });
  });

  it("rejects accessToken SecretRefs with a missing env value", () => {
    vi.stubEnv("MATRIX_ACCESS_TOKEN", "ambient-token");
    vi.stubEnv("MATRIX_PASSWORD", "ambient-password");
    vi.stubEnv("MATRIX_TEST_SECRET", "ambient-secret");
    const cfg = secretConfig("accessToken");
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
    const cfg = secretConfig("password", "shared", {
      defaults: { env: "shared" },
      providers: { shared: { source: "env", allowlist: [...allowlist] } },
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
      const cfg = secretConfig("accessToken", "other", {
        providers: declaration ? { other: declaration } : undefined,
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

    expect(resolveMatrixAuthContext({ cfg, accountId: "ops", env }).resolved).toMatchObject(
      expected,
    );
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
        dangerouslyAllowPrivateNetwork: true,
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

vi.mock("../credentials-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials-read.js")>()),
  loadMatrixCredentialsAsync: async () => null,
  credentialsMatchConfig: () => false,
}));
// mock-isolation: Loopback auth probes must not persist their synthetic credentials.
vi.mock("../credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials.js")>()),
  saveMatrixCredentials: async () => {},
}));

describe("Matrix auth transport and retirement", () => {
  const identity = { user_id: "@fixture:example.org", device_id: "FIXTURE" };
  const token = "synthetic-token";
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    installMatrixTestRuntime({ logging: { getChildLogger: () => logger } });
  });
  afterEach(() => vi.restoreAllMocks());

  async function listen(server: http.Server) {
    onTestFinished(async () => {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback fixture address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("authenticates identity, login, and probe outcomes without opening probe state (#61317)", async () => {
    let requests = 0;
    let rejectLogin = false;
    const server = http.createServer((request, response) => {
      requests++;
      const login = request.url === "/_matrix/client/v3/login";
      const rejected = login
        ? rejectLogin
        : request.headers.authorization === "Bearer expired-token";
      response.writeHead(rejected ? 401 : 200, { "content-type": "application/json" });
      const payload = { ...identity, access_token: login ? token : undefined };
      response.end(JSON.stringify(rejected ? { error: "Invalid credentials" } : payload));
    });
    const homeserver = await listen(server);
    const matrix = { homeserver, network: { dangerouslyAllowPrivateNetwork: true } };
    const authenticate = (auth: { accessToken?: string; userId?: string; password?: string }) =>
      resolveMatrixAuth({ cfg: { channels: { matrix: { ...matrix, ...auth } } }, env: {} });
    await expect(authenticate({ accessToken: token })).resolves.toMatchObject({
      userId: identity.user_id,
      deviceId: identity.device_id,
      allowPrivateNetwork: true,
    });
    const login = { userId: identity.user_id, password: "synthetic-password" };
    await expect(authenticate(login)).resolves.toMatchObject({
      userId: "@fixture:example.org",
      accessToken: token,
    });
    rejectLogin = true;
    await expect(authenticate(login)).rejects.toMatchObject({ statusCode: 401 });
    const stateAccess = (
      ["openKeyedStore", "openKeyedStoreV2", "openSyncKeyedStore", "openBlobStore"] as const
    ).map((method) => vi.spyOn(getMatrixRuntime().state, method));
    for (const [outcome, expected] of Object.entries({
      success: { ok: true },
      mismatch: { ok: false, error: expect.stringContaining("does not match configured userId") },
      unauthorized: { ok: false, status: 401 },
    })) {
      const result = await probeMatrix({
        homeserver,
        accessToken: outcome === "unauthorized" ? "expired-token" : token,
        userId: outcome === "mismatch" ? "@other:example.org" : "@fixture:example.org",
        allowPrivateNetwork: true,
      });
      expect(result).toMatchObject(expected);
    }
    for (const open of stateAccess) {
      expect(open).not.toHaveBeenCalled();
    }
    expect(requests).toBe(6);
  });

  it("cancels an in-flight whoami request and joins backfill on monitor retirement", async () => {
    const received = createDeferred<void>();
    const closed = createDeferred<void>();
    const server = http.createServer((request, response) => {
      expect(request.url).toBe("/_matrix/client/v3/account/whoami");
      response.once("close", closed.resolve);
      received.resolve();
    });
    const runner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: () => {} });
    let task: Promise<void> | undefined;
    try {
      const homeserver = await listen(server);
      task = runner.runDetachedTask("deviceId backfill", async () => {
        const result = await backfillMatrixAuthDeviceIdAfterStartup({
          auth: {
            homeserver,
            userId: "@fixture:example.org",
            accountId: "default",
            accessToken: token,
            ssrfPolicy: { allowPrivateNetwork: true },
          },
          abortSignal: getMatrixMonitorTaskSignal(),
        });
        expect(result).toBeUndefined();
      });
      await Promise.race([
        received.promise,
        task.then(() => {
          throw new Error("Backfill settled before reaching the loopback fixture");
        }),
      ]);
      runner.close();
      const retired = runner.waitForIdle();
      await closed.promise;
      await retired;
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      runner.close();
      server.closeAllConnections();
      await task;
    }
  });
});
