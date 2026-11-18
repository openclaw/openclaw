import path from "node:path";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt diagnostics", () => {
  it("emits only bounded plugin/runtime and Goal catalog metadata at thread readiness", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const canary = "private-prompt-schema-credential-canary";
    params.prompt = canary;
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    params.onAgentEvent = (event) => {
      events.push(event);
    };
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => [
      { ...createRuntimeDynamicTool("update_goal"), description: canary },
      createRuntimeDynamicTool("message"),
    ]);
    const pluginProvenance = {
      source: "/fixture/codex/index.ts",
      runtimeSource: "/fixture/dist/codex.js",
      rootDir: "/fixture/codex",
      version: "2026.10.3",
    };
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, { pluginProvenance });
    await awaitGateBeforeSettlement(
      harness.waitForMethod("turn/start"),
      run,
      "Codex attempt settled before turn/start",
    );
    const ready = events.find(
      (event) =>
        event.stream === "codex_app_server.lifecycle" && event.data.phase === "thread_ready",
    );
    expect(ready?.data).toMatchObject({
      plugin: pluginProvenance,
      runtime: { configuredTransport: "stdio", workerHostedCloud: false },
      goalControls: [{ name: "update_goal", namespace: null, deferLoading: false }],
    });
    expect(JSON.stringify(ready)).not.toContain(canary);
    expect(JSON.stringify(ready)).not.toContain("inputSchema");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });
});
