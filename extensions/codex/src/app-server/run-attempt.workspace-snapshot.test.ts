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

describe("Codex workspace instruction snapshots", () => {
  it.each(["async preparation", "synchronous supplement"] as const)(
    "keeps loaded workspace instructions when optional memory %s fails",
    async (contributionKind) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const executionDir = path.join(tempDir, "workspace");
      const agentWorkspaceDir = path.join(tempDir, "agent-workspace");
      const initialGuidance = "Keep these successfully loaded workspace instructions.";
      const updatedGuidance = "Later workspace changes wait for a new session.";
      await fs.mkdir(agentWorkspaceDir, { recursive: true });
      await fs.writeFile(path.join(agentWorkspaceDir, "AGENTS.md"), initialGuidance);
      const params = createParams(sessionFile, executionDir);
      setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("memory_get")]);
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.bootstrapWorkspaceDir = agentWorkspaceDir;
      setCodexTestModelSupportsTools(params, true);
      setAgentWorkspaceForTest(params, agentWorkspaceDir);
      const registration = createPluginRegistry({
        runtime: createPluginRuntimeMock(),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "workspace-memory-failure" });
      registration.registry.plugins.push(record);
      const api = registration.createApi(record, { config: params.config ?? {} });
      const memoryContribution = vi.fn((_context: unknown): string[] => []);
      const memoryFailure = new Error("optional memory contribution unavailable");
      const warn = vi.spyOn(agentHarnessRuntime.embeddedAgentLog, "warn");
      memoryContribution.mockImplementationOnce(() => {
        throw memoryFailure;
      });
      if (contributionKind === "async preparation") {
        api.registerMemoryPromptPreparation(async (context) => memoryContribution(context));
      } else {
        api.registerMemoryPromptSupplement(memoryContribution);
      }
      try {
        await withPluginRuntimeRegistryScope(registration.registry, async () => {
          const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
          const run = runCodexAppServerAttempt(params);
          await Promise.race([run, harness.waitForMethod("turn/start")]);
          await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
          expect(readAttemptTerminal(await run).promptError).toBeNull();
          expect(warn).toHaveBeenCalledWith("failed to prepare codex memory recall instructions", {
            error: memoryFailure,
          });
          expect(memoryContribution).toHaveBeenCalledWith(
            expect.objectContaining({ availableTools: new Set(["memory_get"]) }),
          );
          const started = harness.requests.find(({ method }) => method === "thread/start");
          assert(started);
          expect(
            (started.params as { developerInstructions?: string }).developerInstructions,
          ).toContain(initialGuidance);
          expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
            agentWorkspaceDeveloperInstructions: expect.stringContaining(initialGuidance),
          });

          await fs.writeFile(path.join(agentWorkspaceDir, "AGENTS.md"), updatedGuidance);
          harness.close();
          const resumeHarness = createResumeHarness("thread-1");
          const resumedRun = runCodexAppServerAttempt(params);
          await Promise.race([resumedRun, resumeHarness.waitForMethod("turn/start")]);
          await resumeHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
          expect(readAttemptTerminal(await resumedRun).promptError).toBeNull();
          const resumed = resumeHarness.requests.find(({ method }) => method === "thread/resume");
          assert(resumed);
          const instructions =
            (resumed.params as { developerInstructions?: string }).developerInstructions ?? "";
          expect(instructions).toContain(initialGuidance);
          expect(instructions).not.toContain(updatedGuidance);
        });
      } finally {
        await disposePluginRegistryInstances(registration.registry);
      }
    },
  );

  it.each(["initial", "resume"] as const)(
    "retains the first successful workspace capture after %s bootstrap loading fails",
    async (failureAt) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const executionDir = path.join(tempDir, "workspace");
      const agentWorkspaceDir = path.join(tempDir, "agent-workspace");
      const initialGuidance = "Keep the captured workspace instructions.";
      const updatedGuidance = "Updated instructions require a new captured snapshot.";
      await fs.mkdir(agentWorkspaceDir, { recursive: true });
      await fs.writeFile(path.join(agentWorkspaceDir, "AGENTS.md"), initialGuidance);
      const bootstrap = vi.spyOn(agentHarnessRuntime, "prepareAgentWorkspaceContext");
      if (failureAt === "initial") {
        bootstrap.mockRejectedValueOnce(new Error("workspace bootstrap unavailable"));
      }
      const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
      const params = createParams(sessionFile, executionDir);
      params.bootstrapWorkspaceDir = agentWorkspaceDir;
      setAgentWorkspaceForTest(params, agentWorkspaceDir);
      const run = runCodexAppServerAttempt(params);
      await Promise.race([run, harness.waitForMethod("turn/start")]);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const initialResult = await run;
      expect(readAttemptTerminal(initialResult).promptError).toBeNull();
      if (failureAt === "initial") {
        expect(
          (await readCodexAppServerBinding(sessionFile))?.agentWorkspaceDeveloperInstructions,
        ).toBeUndefined();
      }

      await fs.writeFile(path.join(agentWorkspaceDir, "AGENTS.md"), updatedGuidance);
      harness.close();
      if (failureAt === "resume") {
        bootstrap.mockRejectedValueOnce(new Error("workspace bootstrap unavailable"));
      }
      const resumeHarness = createResumeHarness("thread-1");
      const resumeParams = createParams(sessionFile, executionDir);
      resumeParams.bootstrapWorkspaceDir = agentWorkspaceDir;
      setAgentWorkspaceForTest(resumeParams, agentWorkspaceDir);
      const resumedRun = runCodexAppServerAttempt(resumeParams);
      await Promise.race([resumedRun, resumeHarness.waitForMethod("turn/start")]);
      await resumeHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const resumedResult = await resumedRun;
      expect(readAttemptTerminal(resumedResult).promptError).toBeNull();
      const degradedResult = failureAt === "initial" ? initialResult : resumedResult;
      expect(degradedResult.systemPromptReport?.injectedWorkspaceFiles).toEqual([]);
      const threadResume = resumeHarness.requests.find(({ method }) => method === "thread/resume");
      assert(threadResume);
      const instructions =
        (threadResume.params as { developerInstructions?: string }).developerInstructions ?? "";
      if (failureAt === "resume") {
        expect(instructions).toContain(initialGuidance);
        expect(instructions).not.toContain(updatedGuidance);
      } else {
        expect(instructions).not.toContain(initialGuidance);
        expect(instructions).toContain(updatedGuidance);
      }
    },
  );

  it.each([
    { initial: "present", change: "edited" },
    { initial: "present", change: "emptied" },
    { initial: "present", change: "removed" },
    { initial: "absent", change: "added" },
    { initial: "empty", change: "added" },
    { initial: "legacy", change: "added" },
    { initial: "legacy-empty", change: "added" },
  ] as const)(
    "retains external-cwd agent instructions after $initial AGENTS.md is $change",
    async ({ initial, change }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const executionDir = path.join(tempDir, "workspace");
      const agentWorkspaceDir = path.join(tempDir, "agent-workspace");
      const agentsGuidance = "Follow agent workspace AGENTS guidance.";
      const soulGuidance = "Keep the agent workspace voice.";
      await fs.mkdir(executionDir, { recursive: true });
      await fs.mkdir(agentWorkspaceDir, { recursive: true });
      if (initial === "present" || initial === "empty") {
        await fs.writeFile(
          path.join(agentWorkspaceDir, "AGENTS.md"),
          initial === "empty" ? "" : agentsGuidance,
        );
      }
      await fs.writeFile(path.join(agentWorkspaceDir, "SOUL.md"), soulGuidance);
      await fs.writeFile(path.join(executionDir, "AGENTS.md"), "Execution project instructions");
      const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
      const params = createParams(sessionFile, executionDir);
      params.bootstrapWorkspaceDir = agentWorkspaceDir;
      setAgentWorkspaceForTest(params, agentWorkspaceDir);

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;

      const threadStart = harness.requests.find((request) => request.method === "thread/start");
      if (!threadStart) {
        throw new Error("expected thread/start request");
      }
      const threadInstructions =
        (threadStart.params as { developerInstructions?: string }).developerInstructions ?? "";
      if (initial !== "present") {
        expect(threadInstructions).not.toContain("OpenClaw Agent Workspace Instructions");
      } else {
        expect(threadInstructions).toContain("OpenClaw Agent Workspace Instructions");
        expect(threadInstructions).toContain(path.join(agentWorkspaceDir, "AGENTS.md"));
        expect(threadInstructions).toContain(agentsGuidance);
      }
      expect(threadInstructions).not.toContain(soulGuidance);

      const turnStart = harness.requests.find((request) => request.method === "turn/start");
      if (!turnStart) {
        throw new Error("expected turn/start request");
      }
      const collaborationInstructions =
        (
          turnStart.params as {
            collaborationMode?: { settings?: { developer_instructions?: string | null } };
          }
        ).collaborationMode?.settings?.developer_instructions ?? "";
      expect(collaborationInstructions).toContain(soulGuidance);
      expect(collaborationInstructions).not.toContain(agentsGuidance);
      const agentWorkspaceStats = result.systemPromptReport?.injectedWorkspaceFiles.find(
        (file) => file.path === path.join(agentWorkspaceDir, "AGENTS.md"),
      );
      expect(agentWorkspaceStats).toMatchObject(
        initial !== "present"
          ? { missing: initial !== "empty", rawChars: 0 }
          : {
              rawChars: agentsGuidance.length,
              injectedChars: agentsGuidance.length,
              truncated: false,
            },
      );

      if (initial === "legacy" || initial === "legacy-empty") {
        const binding = await readCodexAppServerBinding(sessionFile);
        assert(binding);
        await writeCodexAppServerBinding(sessionFile, {
          ...binding,
          agentWorkspaceDeveloperInstructions: undefined,
        });
      }
      const updatedGuidance = "Updated AGENTS guidance must wait for a new session.";
      if (change === "removed") {
        await fs.unlink(path.join(agentWorkspaceDir, "AGENTS.md"));
      } else if (initial !== "legacy-empty") {
        await fs.writeFile(
          path.join(agentWorkspaceDir, "AGENTS.md"),
          change === "emptied" ? "" : updatedGuidance,
        );
      }
      harness.close();
      const resumeHarness = createResumeHarness("thread-1");
      const resumeParams = createParams(sessionFile, executionDir);
      resumeParams.bootstrapWorkspaceDir = agentWorkspaceDir;
      setAgentWorkspaceForTest(resumeParams, agentWorkspaceDir);
      const resumedRun = runCodexAppServerAttempt(resumeParams);
      await Promise.race([resumedRun, resumeHarness.waitForMethod("turn/start")]);
      await resumeHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await resumedRun)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
      expect(resumeHarness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      const threadResume = resumeHarness.requests.find(
        (request) => request.method === "thread/resume",
      );
      if (!threadResume) {
        throw new Error("expected thread/resume request");
      }
      const resumedInstructions =
        (threadResume.params as { developerInstructions?: string }).developerInstructions ?? "";
      if (initial === "present") {
        expect(resumedInstructions).toContain(agentsGuidance);
      }
      if (initial === "legacy") {
        expect(resumedInstructions).toContain(updatedGuidance);
      } else {
        expect(resumedInstructions).not.toContain(updatedGuidance);
      }
      if (initial === "legacy-empty") {
        await fs.writeFile(path.join(agentWorkspaceDir, "AGENTS.md"), updatedGuidance);
        resumeHarness.close();
        const nextHarness = createResumeHarness("thread-1");
        const nextParams = createParams(sessionFile, executionDir);
        nextParams.bootstrapWorkspaceDir = agentWorkspaceDir;
        setAgentWorkspaceForTest(nextParams, agentWorkspaceDir);
        const nextRun = runCodexAppServerAttempt(nextParams);
        await Promise.race([nextRun, nextHarness.waitForMethod("turn/start")]);
        await nextHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        expect(readAttemptTerminal(await nextRun).promptError).toBeNull();
        const nextResume = nextHarness.requests.find(({ method }) => method === "thread/resume");
        assert(nextResume);
        expect(
          (nextResume.params as { developerInstructions?: string }).developerInstructions,
        ).not.toContain(updatedGuidance);
      }
    },
  );
});
