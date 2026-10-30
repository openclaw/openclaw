import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRuntimeConfigSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { discoverAuthStorageFacts } from "./agent-model-discovery.js";
import { resolveLiveCacheProviderPool } from "./live-cache-regression-policy.js";

// mock-isolation: Stop before credential discovery or provider access; config preparation stays real.
vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: vi.fn(),
  discoverModelsAsync: vi.fn(),
}));
// mock-isolation: The preflight regression must never load or invoke provider model resolution.
vi.mock("./embedded-agent-runner/model.js", () => ({ resolveModelAsync: vi.fn() }));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it.each(["cold", "prepared"] as const)(
  "prepares a %s config before live-cache credential discovery",
  async (state) => {
    const home = dirs.make("openclaw-live-cache-config-");
    const bundled = path.join(home, "bundled");
    fs.mkdirSync(bundled);
    const configPath = path.join(home, "openclaw.json");
    const diskAgentDir = path.join(home, "disk-agent");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { entries: { main: { agentDir: diskAgentDir } } } }),
    );
    for (const [key, value] of Object.entries({
      HOME: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: home,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
      OPENCLAW_LOAD_SHELL_ENV: undefined,
    })) {
      vi.stubEnv(key, value);
    }
    vi.spyOn(process, "cwd").mockReturnValue(home);
    resetConfigRuntimeState();
    const agentDir = state === "prepared" ? path.join(home, "runtime-agent") : diskAgentDir;
    if (state === "prepared") {
      setRuntimeConfigSnapshot({ agents: { entries: { main: { agentDir } } } });
    } else {
      expect(getRuntimeConfigSnapshot()).toBeNull();
    }
    const stopBeforeCredentials = new Error("secretless preflight complete");
    vi.mocked(discoverAuthStorageFacts).mockRejectedValue(stopBeforeCredentials);

    await expect(
      resolveLiveCacheProviderPool({
        config: {
          provider: "openai",
          api: "openai-responses",
          envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
          preferredModelIds: ["fixture-model"],
        },
        regressions: [],
        warnings: [],
        summary: { openai: {} },
      }),
    ).rejects.toBe(stopBeforeCredentials);
    expect(getRuntimeConfigSnapshot()?.agents?.entries?.main?.agentDir).toBe(agentDir);
    expect(discoverAuthStorageFacts).toHaveBeenCalledWith(agentDir);
  },
);
