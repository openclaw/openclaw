import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createResumeHarness,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { setAgentWorkspaceForTest } from "./run-attempt-workspace.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();
const initial = "Captured workspace instructions.";
const updated = "Updated instructions must wait for a new session.";

async function workspace(guidance?: string) {
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  params.bootstrapWorkspaceDir = path.join(tempDir, "agent-workspace");
  setAgentWorkspaceForTest(params, params.bootstrapWorkspaceDir);
  await fs.mkdir(params.bootstrapWorkspaceDir, { recursive: true });
  const agentsPath = path.join(params.bootstrapWorkspaceDir, "AGENTS.md");
  if (guidance) {
    await fs.writeFile(agentsPath, guidance);
  }
  return { params, agentsPath };
}

async function attempt(params: ReturnType<typeof createParams>, resume = false) {
  const harness = resume
    ? createResumeHarness("thread-1")
    : createStartedThreadHarness(undefined, { persistedThreads: [] });
  const run = runCodexAppServerAttempt(params);
  await Promise.race([run, harness.waitForMethod("turn/start")]);
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  const result = await run;
  expect(readAttemptTerminal(result)).toMatchObject({
    aborted: false,
    timedOut: false,
    promptError: null,
  });
  expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
  const thread = harness.requests.find(
    ({ method }) => method === (resume ? "thread/resume" : "thread/start"),
  );
  assert(thread);
  const instructions =
    (thread.params as { developerInstructions?: string }).developerInstructions ?? "";
  harness.close();
  return { result, instructions };
}

describe("Codex workspace instruction snapshots", () => {
  it("keeps loaded instructions when optional memory preparation fails and freezes them on resume", async () => {
    const { params, agentsPath } = await workspace(initial);
    setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("memory_get")]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const registration = createPluginRegistry({
      runtime: createPluginRuntimeMock(),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "workspace-memory-failure" });
    registration.registry.plugins.push(record);
    const failure = new Error("optional memory contribution unavailable");
    const warn = vi.spyOn(agentHarnessRuntime.embeddedAgentLog, "warn");
    const api = registration.createApi(record, { config: params.config ?? {} });
    api.registerMemoryPromptPreparation(
      vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(failure).mockResolvedValue([]),
    );
    try {
      await withPluginRuntimeRegistryScope(registration.registry, async () => {
        expect((await attempt(params)).instructions).toContain(initial);
        expect(warn).toHaveBeenCalledWith("failed to prepare codex memory recall instructions", {
          error: failure,
        });
        await fs.writeFile(agentsPath, updated);
        const { instructions } = await attempt(params, true);
        expect(instructions).toContain(initial);
        expect(instructions).not.toContain(updated);
      });
    } finally {
      await disposePluginRegistryInstances(registration.registry);
    }
  });

  it.each(["initial", "resume"] as const)(
    "retains the first successful capture after %s bootstrap loading fails",
    async (failureAt) => {
      const { params, agentsPath } = await workspace(initial);
      const bootstrap = vi.spyOn(agentHarnessRuntime, "prepareAgentWorkspaceContext");
      const failure = new Error("workspace bootstrap unavailable");
      if (failureAt === "initial") {
        bootstrap.mockRejectedValueOnce(failure);
      }
      const started = await attempt(params);
      const captured = await readCodexAppServerBinding(params.sessionFile);
      expect(captured?.agentWorkspaceDeveloperInstructions).toEqual(
        failureAt === "initial" ? undefined : expect.stringContaining(initial),
      );
      await fs.writeFile(agentsPath, updated);
      if (failureAt === "resume") {
        bootstrap.mockRejectedValueOnce(failure);
      }
      const resumed = await attempt(params, true);
      const degraded = failureAt === "initial" ? started : resumed;
      expect(degraded.result.systemPromptReport?.injectedWorkspaceFiles).toEqual([]);
      expect(resumed.instructions).toContain(failureAt === "initial" ? updated : initial);
      expect(resumed.instructions).not.toContain(failureAt === "initial" ? initial : updated);
    },
  );

  it("captures an empty legacy snapshot once and preserves it when AGENTS.md appears", async () => {
    const { params, agentsPath } = await workspace();
    const started = await attempt(params);
    expect(started.instructions).not.toContain("OpenClaw Agent Workspace Instructions");
    const binding = await readCodexAppServerBinding(params.sessionFile);
    assert(binding);
    await writeCodexAppServerBinding(params.sessionFile, {
      ...binding,
      agentWorkspaceDeveloperInstructions: undefined,
    });
    await attempt(params, true);
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.agentWorkspaceDeveloperInstructions,
    ).toBe("");
    await fs.writeFile(agentsPath, updated);
    expect((await attempt(params, true)).instructions).not.toContain(updated);
  });
});
