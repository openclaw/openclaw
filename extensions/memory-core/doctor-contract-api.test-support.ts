import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach } from "vitest";

type AuthoredAgents = NonNullable<OpenClawConfig["agents"]>;
type AuthoredEntry = NonNullable<AuthoredAgents["entries"]>[string];
type AuthoredMemory = NonNullable<OpenClawConfig["memory"]>;
type AuthoredMemorySearch = NonNullable<AuthoredMemory["search"]>;
type RawLegacyMemorySearch = Omit<AuthoredMemorySearch, "store"> & {
  store?: NonNullable<AuthoredMemorySearch["store"]> & { path?: string };
};
/** Pre-Doctor memory-core config: retired roster rows, default markers, and legacy memory-search keys. */
export type RawLegacyDoctorConfig = Omit<OpenClawConfig, "agents" | "memory"> & {
  agents?: Omit<AuthoredAgents, "entries"> & {
    entries?: Record<string, AuthoredEntry & { default?: boolean }>;
    list?: unknown[];
  };
  memory?: Omit<AuthoredMemory, "search"> & { search?: RawLegacyMemorySearch };
  memorySearch?: RawLegacyMemorySearch;
};

export function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("memory-core", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests(
        "memory-core",
        { ...options, env: options.env ?? env },
        entries,
      );
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

export async function resetDoctorPluginState() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

export function useDoctorWorkspace(prefix: string, resetDreaming?: () => void) {
  const fixture = { rootDir: "", workspaceDir: "", stateDir: "", env: process.env };
  const context = () => createDoctorContext(fixture.env);
  const params = (
    config: RawLegacyDoctorConfig = {
      agents: { list: [{ id: "main", workspace: fixture.workspaceDir }] },
    },
  ) => ({
    config,
    env: fixture.env,
    stateDir: fixture.stateDir,
    oauthDir: path.join(fixture.rootDir, "oauth"),
    context: context(),
  });
  beforeEach(async () => {
    await resetDoctorPluginState();
    fixture.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    fixture.workspaceDir = path.join(fixture.rootDir, "workspace");
    fixture.stateDir = path.join(fixture.rootDir, "state");
    fixture.env = { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir };
    await fs.mkdir(path.join(fixture.workspaceDir, "memory", ".dreams"), { recursive: true });
  });
  afterEach(async () => {
    await resetDoctorPluginState();
    resetDreaming?.();
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });
  return { fixture, context, params };
}

export const read = (file: string) => fs.readFile(file, "utf8");
export async function writeFiles(files: string[], contents: string) {
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
}
