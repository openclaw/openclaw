// Covers CLI backend lookup for native compaction ownership.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  createPreparedRuntimeLease,
  prepareCompactionScenario,
  setCliCompactionTestDeps,
} from "./cli-compaction.test-support.js";

describe("runCliTurnCompactionLifecycle backend ownership", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-owner-"));
    setCliCompactionTestDeps({
      resolveCliBackendConfig: () => null,
      acquirePreparedModelRuntime: async (input) => createPreparedRuntimeLease(input),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync(tmpDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves native compaction ownership from the CLI backend, not the model provider", async () => {
    const resolveBackend = vi.fn((backendId: string) =>
      backendId === "claude-cli"
        ? {
            id: "claude-cli",
            config: { command: "claude" },
            bundleMcp: true,
            ownsNativeCompaction: true,
          }
        : null,
    );
    const scenario = await prepareCompactionScenario({
      suffix: "model-provider-with-cli-backend",
      tmpDir,
      provider: "anthropic",
      model: "claude-opus-5-5",
      deps: { resolveCliBackendConfig: resolveBackend as never },
    });
    const updatedEntry = await scenario.run({ cliBackendId: "claude-cli" });

    expect(resolveBackend).toHaveBeenCalledWith("claude-cli", expect.anything());
    expect(scenario.compactCalls).toHaveLength(0);
    expect(scenario.recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(scenario.sessionEntry);
  });

  it("keeps embedded compaction when no CLI backend ran the turn", async () => {
    const resolveBackend = vi.fn(() => null);
    const scenario = await prepareCompactionScenario({
      suffix: "embedded-no-cli-backend",
      tmpDir,
      provider: "openai",
      model: "gpt-5.5",
      deps: { resolveCliBackendConfig: resolveBackend as never },
    });
    await scenario.run();

    expect(resolveBackend).toHaveBeenCalledWith("openai", expect.anything());
    expect(scenario.compactCalls).toHaveLength(1);
  });
});
