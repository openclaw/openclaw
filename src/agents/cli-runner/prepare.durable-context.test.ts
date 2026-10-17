import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  patchSessionEntryCore,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import type { CliBackendExecuteContext } from "../../plugins/cli-backend.types.js";
import * as globalHooks from "../../plugins/hook-runner-global.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { runCliAgent } from "../cli-runner.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { setCliSessionBinding, getCliSessionBinding } from "../cli-session.js";
import { buildBootstrapContextForFiles } from "../embedded-agent-helpers/bootstrap.js";
import * as maintenance from "../embedded-agent-runner/context-engine-maintenance.js";
import { withAdmittedCliCandidate } from "../embedded-agent-runner/run-entry-cli.js";
import { SessionManager } from "../sessions/session-manager.js";
import { executePreparedCliRun } from "./execute.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { RunCliAgentParams, PreparedCliRunContext } from "./types.js";

describe("CLI durable session context", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function prepareOwnedHistory() {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "token",
            provider: "test-cli",
            token: "synthetic-history-account",
          },
          "history-test:unknown": {
            type: "oauth",
            provider: "test-cli",
            access: "synthetic-identityless-access",
            refresh: "synthetic-identityless-refresh",
            expires: Date.now() + 60_000,
          },
          "history-test:other": {
            type: "token",
            provider: "test-cli",
            token: "synthetic-other-account",
          },
        },
      },
      agentDir,
    );
    const prepared = await fixture.prepare({ agentDir, authProfileId });
    cleanups.push(() => prepared.preparedBackend.cleanup?.());
    expect(prepared.cliHistoryWriter).toBeDefined();
    return {
      appendTranscript: (entry: Parameters<typeof fixture.appendTranscript>[0]) =>
        runWithCliHistoryWriter(prepared.cliHistoryWriter, () => fixture.appendTranscript(entry)),
      prepare: (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
        fixture.prepare({
          agentDir,
          authProfileId,
          admittedRunContext: prepared.params.admittedRunContext,
          ...overrides,
        }),
    };
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext(params);
    });
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      setActiveNodeContexts([]);
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      await fixture.cleanup();
      clearRuntimeConfigSnapshot();
    }
  });

  it("claims metadata ownership through the actual admitted CLI entry without an injected scope", async () => {
    const target = fixture.session.sessionTarget;
    const config = { agents: { defaults: { workspaceContextRefresh: "compaction" as const } } };
    setRuntimeConfigSnapshot(config);
    let content = "ENTRY_FIRST";
    let executions = 0;
    const delivered: string[] = [];
    let retained: CliBackendExecuteContext["workspaceContext"];
    const backend = {
      ...buildDefaultTestCliBackend(),
      id: "claude-cli",
      modelProvider: "test-cli",
      config: {
        ...buildDefaultTestCliBackend().config,
        command: process.execPath,
        output: "json" as const,
      },
      prepareExecution: () => ({
        async *execute(context: CliBackendExecuteContext) {
          retained = context.workspaceContext;
          delivered.push((await retained?.("resume")) ?? "MISSING");
          if (++executions === 2) {
            delivered.push((await retained?.("compact")) ?? "MISSING");
          }
          yield { type: "result", subtype: "success", result: "complete" };
        },
      }),
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: async () => ({
        bootstrapFiles: [{ name: "AGENTS.md", path: "AGENTS.md", content, missing: false }],
        contextFiles: [{ path: "AGENTS.md", content }],
      }),
    });
    const run = async (runId: string, beforeRun?: () => Promise<void>) => {
      const admission = prepareSystemAgentRunAdmission(config, runId, "main", "cli-entry-test");
      try {
        return await withAdmittedCliCandidate(
          {
            claim: {
              agentId: "main",
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              runId,
            },
            admission: { preparedRunAdmission: admission },
            provider: "claude-cli",
            sessionTarget: target,
            expectedLifecycleRevision: loadSessionEntryReadOnly(target)?.lifecycleRevision,
            readMode: "read-only",
            getSessionEntry: () => loadSessionEntryReadOnly(target),
          },
          async ({ sessionEntry, assertSettlementCurrent }) => {
            await beforeRun?.();
            return runCliAgent({
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              sessionTarget: target,
              sessionEntry,
              storePath: target.storePath,
              sessionFile: fixture.session.sessionFile,
              workspaceDir: fixture.session.dir,
              prompt: "latest ask",
              provider: "claude-cli",
              model: "test-model",
              timeoutMs: 1000,
              runId,
              config,
              skillsSnapshot: { prompt: "", skills: [] },
              preparedRunAdmission: admission,
              assertCurrent: assertSettlementCurrent,
              persistAssistantTranscript: true,
            });
          },
        );
      } finally {
        admission.close();
      }
    };
    expect(
      (await run("entry-first")).payloads?.some((payload) => payload.text === "complete"),
    ).toBe(true);
    expect(delivered[0]).toContain("ENTRY_FIRST");
    await expect(retained?.("compact")).rejects.toThrow();
    content = "ENTRY_SECOND";
    expect(
      (await run("entry-second")).payloads?.some((payload) => payload.text === "complete"),
    ).toBe(true);
    expect(delivered[1]).toContain("ENTRY_FIRST");
    expect(delivered[2]).toContain("ENTRY_SECOND");
    expect(loadSessionEntryReadOnly(target)).toMatchObject({ activeWriterRunId: "entry-second" });
    expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
    const messages = (await SessionManager.openAsync(target, fixture.session.dir)).getEntries();
    expect(messages.filter((entry) => entry.type === "message")).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain("complete");
    const inheritedTarget = {
      ...target,
      storePath: path.join(fixture.session.dir, "agents", "main", "sessions", "sessions.json"),
      expectedWriterRunId: "entry-inherited",
    };
    await patchSessionEntryCore(target, () => ({ activeWriterRunId: "entry-inherited" }));
    const inherited = await withOwnedSessionTranscriptWrites(
      { sessionTarget: inheritedTarget, withTranscriptWrite: async (write) => await write() },
      () =>
        fixture.prepare({
          runId: "entry-inherited",
          provider: "claude-cli",
          sessionKey: target.sessionKey,
          sessionTarget: inheritedTarget,
          sessionEntry: loadSessionEntryReadOnly(target),
          config,
        }),
    );
    cleanups.push(() => inherited.preparedBackend.cleanup?.());
    expect(inherited.params.sessionTarget?.storePath).toBe(inheritedTarget.storePath);
    expect(await inherited.workspaceContext?.("resume")).toContain("ENTRY_SECOND");
    await expect(
      run("entry-stale", async () => {
        await patchSessionEntryCore(target, () => ({ lifecycleRevision: "reset-after-admission" }));
      }),
    ).rejects.toThrow("CLI transcript owner changed");
    const foreign = prepareSystemAgentRunAdmission(
      config,
      "foreign-writer",
      "main",
      "foreign-test",
    );
    try {
      await foreign.admit("embedded");
      await patchSessionEntryCore(target, () => ({ activeWriterRunId: "foreign-writer" }));
      await expect(run("entry-foreign")).rejects.toThrow("CLI transcript owner is still active");
      expect(loadSessionEntryReadOnly(target)).toMatchObject({
        activeWriterRunId: "foreign-writer",
      });
    } finally {
      foreign.close();
    }
  });

  it("prestamps a legacy native binding before snapshot persistence and retries without adopting history", async () => {
    const backend = {
      ...buildDefaultTestCliBackend(),
      id: "claude-cli",
      config: { ...buildDefaultTestCliBackend().config, input: "stdin" as const },
      prepareExecution: () => ({
        async *execute() {
          yield { type: "result" };
        },
      }),
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    let content = "LEGACY_WORKSPACE_FIRST";
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: async () => ({
        bootstrapFiles: [{ name: "AGENTS.md", path: "AGENTS.md", content, missing: false }],
        contextFiles: [{ path: "AGENTS.md", content }],
      }),
      claudeCliSessionTranscriptHasContent: async () => true,
      claudeCliSessionTranscriptHasOrphanedToolUse: async () => false,
    });
    fixture.appendTranscript({
      id: "legacy-input",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "LEGACY_PRIVATE_HISTORY", timestamp: 1 },
    });
    const baseline = await fixture.prepare({ provider: "claude-cli" });
    cleanups.push(() => baseline.preparedBackend.cleanup?.());
    const binding = {
      sessionId: "existing-native-id",
      authProfileId: baseline.effectiveAuthProfileId,
      authEpoch: baseline.authEpoch,
      authEpochVersion: baseline.authEpochVersion,
      extraSystemPromptHash: baseline.extraSystemPromptHash,
      messageToolPolicyHash: baseline.messageToolPolicyHash,
      promptToolNamesHash: baseline.promptToolNamesHash,
      cwdHash: baseline.cwdHash,
      mcpConfigHash: baseline.preparedBackend.mcpConfigHash,
      mcpResumeHash: baseline.preparedBackend.mcpResumeHash,
    };
    const target = fixture.session.sessionTarget;
    await patchSessionEntryCore(target, (entry) => {
      setCliSessionBinding(entry, "claude-cli", binding);
      return entry;
    });
    let attempt = 0;
    const prepare = async () => {
      const runId = `host-legacy-${++attempt}`;
      await patchSessionEntryCore(target, (entry) => ({ ...entry, activeWriterRunId: runId }));
      return await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...target, expectedWriterRunId: runId },
          withTranscriptWrite: async (run) => await run(),
        },
        async () => {
          const prepared = await fixture.prepare({
            runId,
            expectedWriterRunId: runId,
            provider: "claude-cli",
            sessionKey: target.sessionKey,
            cliSessionBinding: getCliSessionBinding(loadSessionEntryReadOnly(target), "claude-cli"),
            config: { agents: { defaults: { workspaceContextRefresh: "compaction" } } },
          });
          cleanups.push(() => prepared.preparedBackend.cleanup?.());
          return prepared;
        },
      );
    };
    const append = vi
      .spyOn(SessionManager.prototype, "appendCustomEntryAsync")
      .mockRejectedValueOnce(new Error("snapshot persistence failed"));
    await expect(prepare()).rejects.toThrow("snapshot persistence failed");
    append.mockRestore();
    const stamped = getCliSessionBinding(loadSessionEntryReadOnly(target), "claude-cli");
    expect(stamped?.sessionId).toBe("existing-native-id");
    expect(stamped?.workspaceContextScopeHash).toBeTruthy();
    expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
    const retry = await prepare();
    expect(retry.reusableCliSession).toMatchObject({ sessionId: "existing-native-id" });
    expect(retry.cliHistoryWriter).toBeUndefined();
    expect(retry.openClawHistoryPrompt ?? "").not.toContain("LEGACY_PRIVATE_HISTORY");
    expect(await retry.workspaceContext?.("resume")).toContain("LEGACY_WORKSPACE_FIRST");
    content = "LEGACY_WORKSPACE_SECOND";
    const restarted = await prepare();
    expect(restarted.reusableCliSession).toMatchObject({ sessionId: "existing-native-id" });
    expect(await restarted.workspaceContext?.("resume")).toContain("LEGACY_WORKSPACE_FIRST");
    expect(await restarted.workspaceContext?.("compact")).toContain("LEGACY_WORKSPACE_SECOND");
    expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
    const manager = await SessionManager.openAsync(target, fixture.session.dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: { ...target, expectedWriterRunId: `host-legacy-${attempt}` },
        withTranscriptWrite: async (write) => await write(),
      },
      async () => {
        const message = await manager.appendMessageAsync({
          role: "user",
          content: "Before compact",
          timestamp: 2,
        });
        await manager.appendCompactionAsync("Summary", message, 100);
      },
    );
    await patchSessionEntryCore(target, (entry) => {
      setCliSessionBinding(entry, "claude-cli", {
        ...stamped!,
        workspaceContextScopeHash: undefined,
      });
      return entry;
    });
    const previouslyPrivate = await prepare();
    expect(previouslyPrivate.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "workspace-context",
    });
  });

  it("keeps workspace bytes out of the stable system and recovers the durable snapshot across preparation", async () => {
    const sent: CliBackendExecuteContext[] = [];
    const baseBackend = buildDefaultTestCliBackend({
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const backend = {
      ...baseBackend,
      id: "claude-cli",
      config: { ...baseBackend.config, command: process.execPath, input: "stdin" as const },
      manualCompaction: {
        input: "arg" as const,
        buildPrompt: () => "/compact",
        validateOutput: (output: string) =>
          output.includes('"compact_boundary"')
            ? { ok: true as const }
            : { ok: false as const, reason: "No native compaction boundary" },
      },
      prepareExecution: () => ({
        async *execute(context: CliBackendExecuteContext) {
          sent.push(context);
          yield { type: "system", subtype: "compact_boundary" };
          yield { type: "result" };
        },
      }),
    };
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [backend],
    });
    let content = "WORKSPACE_FIRST";
    let policyTail = "Policy body. ".repeat(100);
    const load = vi.fn(
      async (input: {
        contextMode?: string;
        config?: import("../../config/types.openclaw.js").OpenClawConfig;
      }) => {
        const bootstrapFiles =
          input.contextMode === "lightweight"
            ? []
            : [
                {
                  name: "BOOTSTRAP.md",
                  path: "BOOTSTRAP.md",
                  content: "EXCLUDED_RITUAL".repeat(100),
                  missing: false,
                },
                {
                  name: "AGENTS.md",
                  path: "AGENTS.md",
                  content: content + "\n" + policyTail,
                  missing: false,
                },
              ];
        return {
          bootstrapFiles,
          contextFiles: buildBootstrapContextForFiles(bootstrapFiles, { config: input.config }),
        };
      },
    );
    setCliRunnerPrepareTestDeps({ resolveBootstrapContextForRun: load });
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    const authProfileId = "snapshot:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "token",
            provider: "claude-cli",
            token: "synthetic-snapshot-account",
          },
        },
      },
      agentDir,
    );
    let snapshotRun = 0;
    let previousSnapshotAdmission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
    const prepare = async (
      bootstrapContextMode: "full" | "lightweight" = "full",
      overrides: Partial<RunCliAgentParams> = {},
    ) => {
      previousSnapshotAdmission?.close();
      const config = {
        agents: {
          defaults: { workspaceContextRefresh: "compaction" as const, bootstrapMaxChars: 200 },
        },
      };
      const runId = `workspace-snapshot-${++snapshotRun}`;
      const admission = prepareSystemAgentRunAdmission(
        config,
        runId,
        "main",
        "workspace-snapshot-test",
      );
      previousSnapshotAdmission = admission;
      cleanups.push(() => admission.close());
      return fixture.prepare({
        bootstrapContextMode,
        runId,
        admittedRunContext: await admission.admit("embedded"),
        provider: "claude-cli",
        agentDir,
        authProfileId,
        sessionKey: fixture.session.sessionTarget.sessionKey,
        config,
        ...overrides,
      });
    };
    const persistNativeBinding = async (context: PreparedCliRunContext) => {
      const stored = await patchSessionEntryCore(fixture.session.sessionTarget, (entry) => {
        setCliSessionBinding(entry, "claude-cli", {
          sessionId: "synthetic-private-native-session",
          workspaceContextScopeHash: context.workspaceContextScopeHash,
          authProfileId: context.effectiveAuthProfileId,
          authEpoch: context.authEpoch,
          authEpochVersion: context.authEpochVersion,
          extraSystemPromptHash: context.extraSystemPromptHash,
          messageToolPolicyHash: context.messageToolPolicyHash,
          promptToolNamesHash: context.promptToolNamesHash,
          cwdHash: context.cwdHash,
          mcpConfigHash: context.preparedBackend.mcpConfigHash,
          mcpResumeHash: context.preparedBackend.mcpResumeHash,
        });
        return entry;
      });
      return stored ? getCliSessionBinding(stored, "claude-cli") : undefined;
    };
    const first = await prepare();
    cleanups.push(() => first.preparedBackend.cleanup?.());
    expect(first.systemPrompt).not.toContain("WORKSPACE_FIRST");
    const startupContext = await first.workspaceContext?.("startup");
    expect(startupContext).toContain("WORKSPACE_FIRST");
    expect(startupContext).toContain("AGENTS.md");
    expect(startupContext).toContain("[Bootstrap truncation warning]");
    expect(startupContext).not.toContain("BOOTSTRAP.md");
    expect(startupContext).not.toContain("EXCLUDED_RITUAL");
    await expect(first.cliHistoryWriter?.assertReadable()).resolves.toBeUndefined();
    const history = await SessionManager.openAsync(
      fixture.session.sessionTarget,
      fixture.session.dir,
    );
    await runWithCliHistoryWriter(first.cliHistoryWriter, () =>
      history.appendMessageAsync({
        role: "user",
        content: "RECOVERABLE_CONVERSATION",
        timestamp: 1,
      }),
    );
    content = "WORKSPACE_SECOND";
    const resumed = await prepare();
    cleanups.push(() => resumed.preparedBackend.cleanup?.());
    expect(await resumed.workspaceContext?.("resume")).toContain("WORKSPACE_FIRST");
    expect(load).toHaveBeenCalledTimes(1);
    expect(await resumed.workspaceContext?.("compact")).toContain("WORKSPACE_SECOND");
    expect(load).toHaveBeenCalledTimes(2);
    await expect(resumed.cliHistoryWriter?.assertReadable()).resolves.toBeUndefined();
    expect(resumed.systemPrompt).toBe(first.systemPrompt);
    const fullBinding = await persistNativeBinding(resumed);
    const lightweight = await prepare("lightweight", { cliSessionBinding: fullBinding });
    cleanups.push(() => lightweight.preparedBackend.cleanup?.());
    expect(lightweight.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "workspace-context",
    });
    expect(lightweight.openClawHistoryPrompt).toContain("RECOVERABLE_CONVERSATION");
    expect(lightweight.openClawHistoryPrompt).not.toContain("WORKSPACE_FIRST");
    expect(await lightweight.workspaceContext?.("startup")).toBe("");
    expect(await lightweight.workspaceContext?.("compact")).toBe("");
    await expect(lightweight.cliHistoryWriter?.assertReadable()).resolves.toBeUndefined();
    const fullAgain = await prepare();
    cleanups.push(() => fullAgain.preparedBackend.cleanup?.());
    expect(await fullAgain.workspaceContext?.("resume")).toContain("WORKSPACE_SECOND");
    expect(fullAgain.workspaceContextScopeHash).not.toBe(lightweight.workspaceContextScopeHash);
    policyTail = "";
    const untruncated = await fullAgain.workspaceContext?.("compact");
    expect(untruncated).toContain("WORKSPACE_SECOND");
    expect(untruncated).not.toContain("[Bootstrap truncation warning]");
    expect(untruncated).not.toContain("BOOTSTRAP.md");
    const sameScopeBinding = await persistNativeBinding(fullAgain);
    const beforeControl = load.mock.calls.length;
    const compact = await prepare("full", {
      cliSessionBinding: sameScopeBinding,
      controlOperation: "compact",
      prompt: "/compact",
    });
    cleanups.push(() => compact.preparedBackend.cleanup?.());
    expect(compact.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "synthetic-private-native-session",
    });
    expect(load.mock.calls.length).toBe(beforeControl);
    expect(compact.executionTarget.kind).toBe("plugin");
    await executePreparedCliRun(compact, "synthetic-private-native-session");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.prompt).toBe("/compact");
    expect(sent[0]?.args).not.toContain("/compact");
    expect(sent[0]?.workspaceContext).toBeTypeOf("function");
    expect(await compact.workspaceContext?.("compact")).toContain("WORKSPACE_SECOND");
    await expect(compact.cliHistoryWriter?.assertReadable()).resolves.toBeUndefined();
    await expect(
      prepare("lightweight", {
        cliSessionBinding: sameScopeBinding,
        controlOperation: "compact",
        prompt: "/compact",
      }),
    ).rejects.toThrow("Native compaction cannot cross workspace context scopes");
    const changedProfile = await prepare("full", {
      cliSessionBinding: sameScopeBinding,
      bootstrapUserProfileId: "other-owner",
    });
    cleanups.push(() => changedProfile.preparedBackend.cleanup?.());
    expect(changedProfile.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "workspace-context",
    });
    expect(changedProfile.openClawHistoryPrompt).toContain("RECOVERABLE_CONVERSATION");
    expect(changedProfile.openClawHistoryPrompt).not.toContain("WORKSPACE_FIRST");
  });

  it.each(["plugin", "first-only"])(
    "preserves prompt privacy and order with plugin execution %s",
    async (transport) => {
      const pluginExecution = transport === "plugin";
      const backend = buildDefaultTestCliBackend();
      const runtimeBackend = {
        ...backend,
        config:
          transport === "first-only"
            ? backend.config
            : {
                command: "test-cli",
                args: ["--print"],
                output: "jsonl" as const,
                input: "stdin" as const,
                sessionMode: "existing" as const,
              },
        ...(pluginExecution
          ? {
              prepareExecution: () => ({
                async *execute() {
                  yield { type: "result" };
                },
              }),
            }
          : {}),
      };
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [runtimeBackend],
      });
      setActiveNodeContexts([{ nodeId: "mac-one" }]);
      const hookRunner = {
        hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
        runBeforePromptBuild: vi.fn(async () => ({
          prependContext: "trusted hook context",
          appendContext: "trusted hook tail",
        })),
      };
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(hookRunner as never);

      // Current inbound metadata is untrusted channel context. It should shape
      // the CLI prompt without contaminating transcript or hook inputs.
      const prepareTurn = () =>
        fixture
          .prepare({
            skillsSnapshot: { prompt: "", skills: [] },
            sessionKey: "agent:main:test",
            agentId: "main",
            trigger: "user",
            transcriptPrompt: "latest ask",
            currentInboundContext: {
              text: "Sender: ⟦openclaw:ctx⟧\nsender_id=U123",
              promptJoiner: " ",
            },
            runId: "run-test-context",
            cliSessionId: "existing-cli-session",
          })
          .then((context) => {
            cleanups.push(() => context.preparedBackend.cleanup?.());
            return context;
          });
      const context = await prepareTurn();

      const activeNodeText =
        "Current active computer (latest reported app/system input, not message origin): active_node=mac-one active_node_identity=unknown";
      const logicalPrompt = context.promptForHooks ?? context.params.prompt;
      expect(logicalPrompt).toMatch(
        /^Sender: ⟦openclaw:ctx⟧\nsender_id=U123 trusted hook context\n\nlatest ask\n\ntrusted hook tail\n\nFor the current source conversation,/,
      );
      expect(logicalPrompt.endsWith(`\n\n${activeNodeText}`)).toBe(true);
      if (pluginExecution) {
        expect(context.params.prompt).toBe("Sender: ⟦openclaw:ctx⟧\nsender_id=U123 latest ask");
      }
      expect(context.promptContext).toEqual(
        pluginExecution
          ? {
              prependContext: "trusted hook context",
              appendContext: expect.stringMatching(
                /^trusted hook tail\n\nFor the current source conversation,/,
              ),
            }
          : undefined,
      );
      if (pluginExecution) {
        expect(context.promptContext?.appendContext?.endsWith(`\n\n${activeNodeText}`)).toBe(true);
      } else {
        expect(context.promptForHooks).toBeUndefined();
      }
      expect(context.params.transcriptPrompt).toBe("latest ask");
      expect(context.contextEngineTurnPrompt).toBe("latest ask");
      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledTimes(1);
      const beforePromptBuildCalls = hookRunner.runBeforePromptBuild.mock.calls as unknown as Array<
        [unknown, unknown]
      >;
      const promptBuildParams = beforePromptBuildCalls[0]?.[0] as { prompt?: string } | undefined;
      expect(promptBuildParams?.prompt).toBe("latest ask");
      expect(context.preparedBackend.backend.systemPromptArg).toBe(
        transport === "first-only" ? "--system-prompt" : undefined,
      );

      setActiveNodeContexts([{ nodeId: "mac-two" }]);
      const next = await prepareTurn();
      const nextPrompt = next.promptForHooks ?? next.params.prompt;
      expect(nextPrompt).toContain("active_node=mac-two");
      expect(nextPrompt).not.toContain("active_node=mac-one");

      setActiveNodeContexts([{ nodeId: "mac-two", isCurrent: () => false }]);
      const revoked = await prepareTurn();
      const revokedPrompt = revoked.promptForHooks ?? revoked.params.prompt;
      expect(revokedPrompt).toContain("active_node=unknown");
      expect(revokedPrompt).not.toContain("active_node=mac-two");
      expect(revoked.params.transcriptPrompt).toBe("latest ask");
    },
  );

  it.each([
    { backendId: "claude-cli", transport: "plugin", relocate: true },
    { backendId: "claude-cli", transport: "process", relocate: false },
    { backendId: "test-cli", transport: "plugin", relocate: false },
  ])(
    "preserves current Runtime facts for $backendId $transport sessions",
    async ({ backendId, transport, relocate }) => {
      const backend = {
        ...buildDefaultTestCliBackend(),
        id: backendId,
        modelProvider: "test-cli",
        config: { ...buildDefaultTestCliBackend().config, systemPromptWhen: "always" as const },
        ...(transport === "plugin"
          ? {
              prepareExecution: () => ({
                async *execute() {
                  yield { type: "result", subtype: "success", result: "complete" };
                },
              }),
            }
          : {}),
      };
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [backend],
      });
      const prepare = async (key: string) => {
        const context = await fixture.prepare({
          provider: backendId,
          sessionKey: key,
          skillsSnapshot: { prompt: "", skills: [] },
        });
        cleanups.push(() => context.preparedBackend.cleanup?.());
        return context;
      };
      const first = await prepare("agent:main:first");
      const second = await prepare("agent:main:second");
      if (relocate) {
        expect(second.systemPrompt).toBe(first.systemPrompt);
        expect(first.systemPrompt).not.toContain("Runtime: ");
        expect(first.promptContext?.appendContext).toContain("Runtime: agent=main");
        expect(first.promptContext?.appendContext).toContain("session=agent:main:first");
        expect(second.promptContext?.appendContext).toContain("session=agent:main:second");
        expect(first.params.prompt).toBe("latest ask");
        expect(second.contextEngineTurnPrompt).toBe("latest ask");
      } else {
        expect(first.systemPrompt).toContain("session=agent:main:first");
        expect(second.systemPrompt).toContain("session=agent:main:second");
        expect(second.systemPrompt).not.toBe(first.systemPrompt);
      }
    },
  );

  it("builds fresh-session caller-memory prompts from hook-mutated prompts", async () => {
    const { dir, sessionTarget } = fixture.session;
    const manager = SessionManager.open(sessionTarget, dir);
    manager.appendMessage({ role: "user", content: "earlier ask", timestamp: 1 });
    manager.appendCompaction(
      "compacted earlier ask",
      expectDefined(manager.getLeafId(), "retained history entry"),
      10_000,
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          ...buildDefaultTestCliBackend(),
          config: {
            command: "test-cli",
            args: ["--print"],
            output: "text",
            input: "arg",
            sessionMode: "existing",
          },
        },
      ],
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({ prependContext: "hook context" })),
    };
    vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(hookRunner as never);
    const context = await fixture.prepare({
      config: { agents: { defaults: { workspace: dir } } },
      prompt: "current ask",
      // This test supplies explicit memory; durable account provenance has separate coverage.
      sessionManager: SessionManager.fromEntries(manager.getEntries(), dir),
    });
    cleanups.push(() => context.preparedBackend.cleanup?.());

    expect(context.params.prompt).toMatch(
      /^hook context\n\ncurrent ask\n\nFor the current source conversation,/,
    );
    expect(context.params.prompt).toMatch(
      /\n\nCurrent active computer .*active_node=unknown active_node_identity=unknown$/,
    );
    expect(context.params.transcriptPrompt).toBe("current ask");
    expect(context.openClawHistoryPrompt).toContain("Compaction summary: compacted earlier ask");
    expect(context.openClawHistoryPrompt).toContain("hook context");
    expect(context.openClawHistoryPrompt).toContain("current ask");
  });

  it("joins deferred maintenance before reading durable context", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [buildDefaultTestCliBackend()],
    });
    const history = await prepareOwnedHistory();
    const { sessionTarget } = fixture.session;
    const wait = vi
      .spyOn(maintenance, "waitForDeferredTurnMaintenanceForSession")
      .mockImplementation(async () => {
        history.appendTranscript({
          id: "completed-maintenance-note",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: {
            role: "custom",
            customType: "openclaw.system-note",
            content: "FACT_AFTER_MAINTENANCE",
            display: false,
            timestamp: 1,
          },
        });
      });
    const context = await history.prepare({ sessionKey: sessionTarget.sessionKey });
    try {
      expect(wait).toHaveBeenCalledExactlyOnceWith(sessionTarget.sessionKey);
      expect(context.params.prompt).toContain("FACT_AFTER_MAINTENANCE");
      expect(context.params.transcriptPrompt).toBe("latest ask");
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it.each([
    { transport: "plugin", resume: false },
    { transport: "process", resume: true },
    { transport: "plugin", resume: true, account: "other" },
    { transport: "process", resume: true, account: "other" },
    { transport: "plugin", resume: true, account: "unknown" },
    { transport: "process", resume: true, account: "unknown" },
    { transport: "plugin", resume: true, callerMemory: true },
    { transport: "plugin", resume: true, revoke: true },
  ])(
    "preserves owned reference facts for $transport, resume=$resume, account=$account, callerMemory=$callerMemory, revoke=$revoke",
    async (testCase) => {
      const sent: Array<Pick<CliBackendExecuteContext, "prompt" | "promptContext">> = [];
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          {
            ...buildDefaultTestCliBackend(),
            config: {
              ...buildDefaultTestCliBackend().config,
              command: process.execPath,
              output: "jsonl",
              jsonlDialect: "claude-stream-json",
            },
            ...(testCase.transport === "plugin"
              ? {
                  prepareExecution: () => ({
                    async *execute(input: CliBackendExecuteContext) {
                      sent.push({ prompt: input.prompt, promptContext: input.promptContext });
                      yield { type: "result", subtype: "success", result: "complete" };
                    },
                  }),
                }
              : {}),
          },
        ],
      });
      const history = await prepareOwnedHistory();
      history.appendTranscript({
        id: "durable-note",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: {
          role: "custom",
          customType: "openclaw.system-note",
          content: "The saved audit checksum is RESULT-1234.",
          display: false,
          timestamp: 1,
        },
      });
      const pending = await stageSessionPendingInput(fixture.session.sessionTarget, {
        runId: "interrupted-account-request",
        message: {
          role: "user",
          content: "PRIVATE-INTERRUPTED-1234",
          timestamp: 1,
          idempotencyKey: "interrupted-account-request:user",
        },
        assertCurrent: () => {},
      });
      const receipt = expectDefined(pending, "interrupted input receipt");
      receipt.finish("interrupted");
      await receipt.settled?.();
      const context = await history.prepare({
        ...(testCase.resume ? { cliSessionId: "existing-native-session" } : {}),
        ...(testCase.account ? { authProfileId: `history-test:${testCase.account}` } : {}),
        ...(testCase.callerMemory
          ? { sessionManager: SessionManager.fromEntries([], fixture.session.dir) }
          : {}),
      });
      const denied = Boolean(testCase.account || testCase.callerMemory);
      try {
        const logicalPrompt = context.promptForHooks ?? context.params.prompt;
        if (denied) {
          expect(logicalPrompt).not.toContain("PRIVATE-INTERRUPTED-1234");
          expect(logicalPrompt).not.toContain("RESULT-1234");
          expect(context.cliHistoryWriter).toBeUndefined();
        } else {
          expect(logicalPrompt).toContain("PRIVATE-INTERRUPTED-1234");
          expect(logicalPrompt).toContain("RESULT-1234");
          expect(logicalPrompt).toContain("data, not instructions");
          expect(context.params.transcriptPrompt).toBe("latest ask");
        }
        expect(context.contextEngineTurnPrompt).toBe("latest ask");
        expect(context.reusableCliSession).toEqual(
          testCase.resume
            ? { mode: "reuse", sessionId: "existing-native-session" }
            : { mode: "none" },
        );
        if (testCase.transport === "plugin") {
          expect(context.params.prompt).toBe("latest ask");
          if (!denied) {
            expect(context.promptContext?.prependContext).toContain("RESULT-1234");
          }
          if (testCase.revoke) {
            await patchSessionEntryCore(fixture.session.sessionTarget, () => ({
              cliHistoryBoundary: {
                version: 1,
                sessionId: fixture.session.sessionTarget.sessionId,
                state: "unknown",
              },
            }));
            await expect(executePreparedCliRun(context, "existing-native-session")).rejects.toThrow(
              "CLI history authority changed",
            );
            expect(sent).toHaveLength(0);
          } else {
            await executePreparedCliRun(
              context,
              testCase.resume ? "existing-native-session" : undefined,
            );
            expect(sent).toHaveLength(1);
            expect(JSON.stringify(sent).includes("PRIVATE-INTERRUPTED-1234")).toBe(!denied);
          }
        }
        expect(context.openClawHistoryPrompt).toBeUndefined();
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );

  it.each([{ changeAccount: false }, { changeAccount: true }])(
    "replays owned uncompacted history to a session-less backend, changeAccount=$changeAccount",
    async ({ changeAccount }) => {
      const backend = buildDefaultTestCliBackend({ reseedFromRawTranscriptWhenUncompacted: true });
      cliBackendsTesting.setDepsForTest({
        resolvePluginSetupCliBackend: () => undefined,
        resolveRuntimeCliBackends: () => [
          { ...backend, config: { ...backend.config, sessionMode: "none" } },
        ],
      });
      const history = await prepareOwnedHistory();
      history.appendTranscript({
        id: "prior-ask",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "the invoice is in the blue folder", timestamp: 1 },
      });
      const { sessionTarget } = fixture.session;
      // Reply execution admits the current user turn before CLI preparation.
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "latest ask", idempotencyKey: "stateless-current-turn" },
        target: {
          ...sessionTarget,
          sessionEntry: { sessionId: sessionTarget.sessionId, updatedAt: 1 },
        },
      });
      await recorder.persistApproved();
      expect(recorder.getAdmissionReceipt()).toBeDefined();
      const context = await history.prepare({
        userTurnTranscriptRecorder: recorder,
        ...(changeAccount ? { authProfileId: "history-test:other" } : {}),
      });
      cleanups.push(() => context.preparedBackend.cleanup?.());

      expect(context.reusableCliSession).toEqual({ mode: "none" });
      if (changeAccount) {
        expect(context.openClawHistoryPrompt).toBeUndefined();
      } else {
        expect(context.openClawHistoryPrompt).toEqual(
          expect.stringContaining("User: the invoice is in the blue folder"),
        );
        expect(context.openClawHistoryPrompt?.split("latest ask")).toHaveLength(2);
      }
    },
  );
});
