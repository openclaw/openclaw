/**
 * Turn-taint wiring through Codex dynamic-tool build: the params-level
 * `isTurnTainted` gate reaches the coding-tools factory options so memory
 * writes after a network tool are quarantined.
 */
import fs from "node:fs/promises";
import "./dynamic-tool-build.test-support.js";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";

const { buildDynamicToolsForTest, createCodexRuntimePlanFixture, createParams, hoisted } =
  await import("./dynamic-tool-build.test-support.js");

describe("Codex app-server dynamic tool build taint wiring", () => {
  let tempDir: string;

  beforeEach(async () => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-taint-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("forwards the isTurnTainted gate into Codex dynamic tools", async () => {
    const workspaceDir = path.join(tempDir, "taint-workspace");
    const params = createParams(path.join(tempDir, "taint-session.jsonl"), workspaceDir);
    const isTurnTainted = vi.fn(() => true);
    params.disableTools = false;
    params.isTurnTainted = isTurnTainted;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const factoryOptions: unknown[] = [];
    setCodexTestToolFactory(params, (options) => {
      factoryOptions.push(options);
      return [];
    });

    await buildDynamicToolsForTest(params, workspaceDir, { sandbox: null as never });

    expect(factoryOptions[0]).toMatchObject({ isTurnTainted });
  });
});
