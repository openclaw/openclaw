import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";

const { buildDynamicToolsForTest, createCodexRuntimePlanFixture, createParams, hoisted } =
  await import("./dynamic-tool-build.test-support.js");

describe("Codex dynamic tool memory authority", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir: string;

  beforeEach(() => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    tempDir = tempDirs.make("openclaw-codex-memory-audience-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves the exact memory audience through tool construction", async () => {
    const workspaceDir = path.join(tempDir, "memory-audience-workspace");
    const params = createParams(path.join(tempDir, "memory-audience-session.jsonl"), workspaceDir);
    params.disableTools = false;
    params.senderIsOwner = true;
    params.runtimePlan = createCodexRuntimePlanFixture();
    // The adapter must forward, not clone or infer, this host-owned identity.
    // The factory seam inspects the projection without using a synthetic grant.
    params.memoryAudience = Object.freeze({
      kind: "conversation",
      agentId: "main",
      sessionKey: expectDefined(params.sessionKey, "memory audience session key"),
      sessionId: params.sessionId,
    });
    const factory = vi.fn((_options: Parameters<typeof createOpenClawCodingTools>[0]) => []);
    setCodexTestToolFactory(params, factory);

    await buildDynamicToolsForTest(params, workspaceDir);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]?.memoryAudience).toBe(params.memoryAudience);
  });
});
