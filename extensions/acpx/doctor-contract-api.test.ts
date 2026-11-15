import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import { AcpxPluginConfigSchema } from "./src/config-schema.js";

vi.mock("./runtime-api.js", () => {
  throw new Error("Empty-state doctor detection must not load ACPX runtime helpers");
});

it("repairs retired config keys before strict validation and reports doctor --fix", () => {
  expect(legacyConfigRules).toEqual(
    ["strictWindowsCmdWrapper", "queueOwnerTtlSeconds"].map((key) =>
      expect.objectContaining({
        path: ["plugins", "entries", "acpx", "config", key],
        message: expect.stringContaining("openclaw doctor --fix"),
      }),
    ),
  );
  const legacy = { cwd: "/tmp/acpx", strictWindowsCmdWrapper: false, queueOwnerTtlSeconds: 30 };
  const config: OpenClawConfig = {
    plugins: { entries: { acpx: { enabled: true, config: { ...legacy } } } },
  };
  const result = normalizeCompatibilityConfig({ cfg: config });
  const repaired = result.config.plugins?.entries?.acpx;

  expect(result.changes).toEqual([
    "Removed retired ACPX plugin config: plugins.entries.acpx.config.strictWindowsCmdWrapper, plugins.entries.acpx.config.queueOwnerTtlSeconds.",
  ]);
  expect(repaired).toEqual({ enabled: true, config: { cwd: "/tmp/acpx" } });
  expect(AcpxPluginConfigSchema.safeParse(repaired?.config).success).toBe(true);
  expect(config.plugins?.entries?.acpx?.config).toEqual(legacy);
  expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
    config: result.config,
    changes: [],
  });
});

it.each(["missing", "empty"])("ignores %s legacy directories", async (directoryState) => {
  resetPluginStateStoreForTests();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-doctor-"));
  onTestFinished(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  if (directoryState === "empty") {
    await fs.mkdir(path.join(stateDir, "acpx", "sessions"), { recursive: true });
  }
  const migration = expectDefined(
    stateMigrations.find((entry) => entry.id === "acpx-session-owner-resources"),
    "ACP session owner migration",
  );
  await expect(
    migration.detectLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      serviceWorkspaceDir: stateDir,
      context: {
        openPluginStateKeyedStore: (options) =>
          createPluginStateKeyedStoreForTests("acpx", { ...options, env: options.env ?? env }),
        async inspectAcpSessionClaims() {
          throw new Error("No record requires canonical ownership evidence");
        },
      },
    }),
  ).resolves.toBeNull();
  expect(await fs.readdir(stateDir)).toEqual(directoryState === "empty" ? ["acpx"] : []);
});
