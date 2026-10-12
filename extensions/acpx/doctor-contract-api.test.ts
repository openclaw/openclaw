// ACPX tests cover doctor repair of legacy config and runtime state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import { AcpxPluginConfigSchema } from "./src/config-schema.js";

vi.mock("./runtime-api.js", () => {
  throw new Error("Empty-state doctor detection must not load ACPX runtime helpers");
});

describe("acpx doctor config repair", () => {
  it("flags both retired config keys for openclaw doctor --fix", () => {
    expect(legacyConfigRules).toEqual([
      expect.objectContaining({
        path: ["plugins", "entries", "acpx", "config", "strictWindowsCmdWrapper"],
        message: expect.stringContaining("openclaw doctor --fix"),
      }),
      expect.objectContaining({
        path: ["plugins", "entries", "acpx", "config", "queueOwnerTtlSeconds"],
        message: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
  });

  it("removes retired config before strict plugin validation", () => {
    const config = {
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              cwd: "/tmp/acpx",
              strictWindowsCmdWrapper: false,
              queueOwnerTtlSeconds: 30,
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Removed retired ACPX plugin config: plugins.entries.acpx.config.strictWindowsCmdWrapper, plugins.entries.acpx.config.queueOwnerTtlSeconds.",
    ]);
    expect(result.config.plugins?.entries?.acpx).toEqual({
      enabled: true,
      config: { cwd: "/tmp/acpx" },
    });
    expect(
      AcpxPluginConfigSchema.safeParse(result.config.plugins?.entries?.acpx?.config).success,
    ).toBe(true);
    expect(config.plugins?.entries?.acpx?.config).toEqual({
      cwd: "/tmp/acpx",
      strictWindowsCmdWrapper: false,
      queueOwnerTtlSeconds: 30,
    });
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });
});

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("acpx", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("acpx doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function migrationParams() {
    return {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  it.each(["missing", "empty"])(
    "does not load runtime helpers or inspect claims when the legacy directory is %s",
    async (directoryState) => {
      if (directoryState === "empty") {
        await fs.mkdir(path.join(stateDir, "acpx", "sessions"), { recursive: true });
      }
      const migration = expectDefined(
        stateMigrations.find((entry) => entry.id === "acpx-session-owner-resources"),
        "ACP session owner migration",
      );
      await expect(
        migration.detectLegacyState({
          ...migrationParams(),
          serviceWorkspaceDir: stateDir,
          context: {
            ...createDoctorContext(env),
            async inspectAcpSessionClaims() {
              throw new Error("No record requires canonical ownership evidence");
            },
          },
        }),
      ).resolves.toBeNull();
      expect(await fs.readdir(stateDir)).toEqual(directoryState === "empty" ? ["acpx"] : []);
    },
  );
});
