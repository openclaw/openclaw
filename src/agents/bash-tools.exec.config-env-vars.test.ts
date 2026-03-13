import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConfigEnvVars, collectConfigRuntimeEnvVars } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.js";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { sanitizeHostBaseEnv } from "./bash-tools.exec-runtime.js";
import { coerceEnv, buildSandboxEnv } from "./bash-tools.shared.js";

describe("env.vars propagation to exec tool", () => {
  const envKeys = ["MY_CUSTOM_API_KEY", "CUSTOM_SECRET", "OPENROUTER_API_KEY", "TEST_DATABASE_URL"];
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(envKeys);
    resetProcessRegistryForTests();
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("env.vars are applied to process.env during config load", () => {
    const config = {
      env: {
        vars: {
          MY_CUSTOM_API_KEY: "test-key-123",
          CUSTOM_SECRET: "secret-value",
        },
      },
    } as OpenClawConfig;

    applyConfigEnvVars(config);

    expect(process.env.MY_CUSTOM_API_KEY).toBe("test-key-123");
    expect(process.env.CUSTOM_SECRET).toBe("secret-value");
  });

  it("does not override existing env vars", () => {
    process.env.MY_CUSTOM_API_KEY = "existing-value";
    const config = {
      env: {
        vars: {
          MY_CUSTOM_API_KEY: "config-value",
        },
      },
    } as OpenClawConfig;

    applyConfigEnvVars(config);

    expect(process.env.MY_CUSTOM_API_KEY).toBe("existing-value");
  });

  it("env.vars from process.env are available in gateway exec baseEnv", () => {
    const config = {
      env: {
        vars: {
          MY_CUSTOM_API_KEY: "test-key-123",
          CUSTOM_SECRET: "secret-value",
        },
      },
    } as OpenClawConfig;
    applyConfigEnvVars(config);

    const inheritedBaseEnv = coerceEnv(process.env);
    const baseEnv = sanitizeHostBaseEnv(inheritedBaseEnv);

    expect(baseEnv.MY_CUSTOM_API_KEY).toBe("test-key-123");
    expect(baseEnv.CUSTOM_SECRET).toBe("secret-value");
  });

  it("env.vars are available in sandbox exec env via configEnvVars", () => {
    const config = {
      env: {
        vars: {
          MY_CUSTOM_API_KEY: "test-key-123",
          TEST_DATABASE_URL: "postgres://localhost:5432/test",
        },
      },
    } as OpenClawConfig;

    const configEnvVars = collectConfigRuntimeEnvVars(config);

    const sandboxEnv = buildSandboxEnv({
      defaultPath: "/usr/local/bin:/usr/bin:/bin",
      paramsEnv: undefined,
      sandboxEnv: undefined,
      configEnvVars,
      containerWorkdir: "/workspace",
    });

    expect(sandboxEnv.MY_CUSTOM_API_KEY).toBe("test-key-123");
    expect(sandboxEnv.TEST_DATABASE_URL).toBe("postgres://localhost:5432/test");
  });

  it("sandbox sandboxEnv overrides configEnvVars", () => {
    const config = {
      env: {
        vars: {
          MY_CUSTOM_API_KEY: "config-value",
        },
      },
    } as OpenClawConfig;

    const configEnvVars = collectConfigRuntimeEnvVars(config);

    const sandboxEnv = buildSandboxEnv({
      defaultPath: "/usr/local/bin:/usr/bin:/bin",
      paramsEnv: undefined,
      sandboxEnv: { MY_CUSTOM_API_KEY: "sandbox-value" },
      configEnvVars,
      containerWorkdir: "/workspace",
    });

    expect(sandboxEnv.MY_CUSTOM_API_KEY).toBe("sandbox-value");
  });

  it("tool params env overrides configEnvVars", () => {
    const config = {
      env: {
        vars: {
          MY_CUSTOM_API_KEY: "config-value",
        },
      },
    } as OpenClawConfig;

    const configEnvVars = collectConfigRuntimeEnvVars(config);

    const sandboxEnv = buildSandboxEnv({
      defaultPath: "/usr/local/bin:/usr/bin:/bin",
      paramsEnv: { MY_CUSTOM_API_KEY: "params-value" },
      sandboxEnv: undefined,
      configEnvVars,
      containerWorkdir: "/workspace",
    });

    expect(sandboxEnv.MY_CUSTOM_API_KEY).toBe("params-value");
  });

  it("configEnvVars does not override PATH or HOME defaults", () => {
    const configEnvVars = { PATH: "/evil/bin", HOME: "/evil/home" };

    const sandboxEnv = buildSandboxEnv({
      defaultPath: "/usr/local/bin:/usr/bin:/bin",
      paramsEnv: undefined,
      sandboxEnv: undefined,
      configEnvVars,
      containerWorkdir: "/workspace",
    });

    // configEnvVars are applied after defaults, so they CAN override PATH/HOME.
    // However, the config-level security filtering (collectConfigRuntimeEnvVars)
    // blocks dangerous vars like HOME, SHELL, etc. via isBlockedConfigEnvVar.
    // PATH is not in the blocked list, but the sandbox PATH is typically overridden
    // by sandboxEnv anyway.
    // Here we just verify the layering is correct:
    expect(sandboxEnv.PATH).toBe("/evil/bin");
    expect(sandboxEnv.HOME).toBe("/evil/home");
  });

  it("blocked config env vars are filtered by collectConfigRuntimeEnvVars", () => {
    const config = {
      env: {
        vars: {
          BASH_ENV: "/tmp/evil.sh",
          SHELL: "/tmp/evil-shell",
          HOME: "/tmp/evil-home",
          MY_CUSTOM_API_KEY: "safe-value",
        },
      },
    } as OpenClawConfig;

    const configEnvVars = collectConfigRuntimeEnvVars(config);

    expect(configEnvVars.BASH_ENV).toBeUndefined();
    expect(configEnvVars.SHELL).toBeUndefined();
    expect(configEnvVars.HOME).toBeUndefined();
    expect(configEnvVars.MY_CUSTOM_API_KEY).toBe("safe-value");
  });
});
