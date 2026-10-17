import fs from "node:fs/promises";
import path from "node:path";
import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import { expect, it, vi } from "vitest";
import {
  upsertSessionEntryCore,
  loadSessionEntryReadOnly,
} from "../../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { prepareBootstrapSnapshot } from "../../bootstrap-snapshot.js";
import { buildBootstrapContextForFiles } from "../../embedded-agent-helpers/bootstrap.js";
import { agentSessionSetContextReplacementHook } from "../../sessions/agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput } from "./attempt-prompt-submit.test-support.js";
import { buildAttemptSystemPrompt } from "./attempt-system-prompt.js";

registerAgentSessionLoopTestLifecycle();

it("shares raw file snapshots across embedded and CLI rendering, then restores fresh files after manual compaction", async () => {
  await withOpenClawTestState({ label: "embedded-workspace-snapshot" }, async (state) => {
    const runId = "workspace-run";
    const target = {
      agentId: "main",
      sessionId: "workspace-session",
      sessionKey: "agent:main:workspace-session",
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      activeWriterRunId: runId,
    });
    const config = {
      agents: {
        defaults: {
          workspaceContextRefresh: "compaction" as const,
          contextInjection: "always" as const,
        },
      },
    };
    const admission = prepareSystemAgentRunAdmission(
      config,
      runId,
      "main",
      "workspace-snapshot-test",
    );
    const admittedRunContext = await admission.admit("embedded");
    const withOwner = <T>(operation: () => Promise<T> | T) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: { ...target, expectedWriterRunId: runId },
          assertCommitAllowed: () => {},
          withTranscriptWrite: async (write) => await write(),
        },
        operation,
      );
    const params = {
      attempt: {
        config,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        runId,
        admittedRunContext,
        operation: "attempt" as const,
        chatType: "direct" as const,
      },
      setup: {
        effectiveWorkspace: state.workspaceDir,
        resolvedWorkspace: state.workspaceDir,
        sessionAgentId: "main",
      },
      snapshotTarget: target,
      isRawModelRun: false,
      hasReadTool: false,
      withOwnedTranscriptWrite: withOwner,
    };
    try {
      await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "FIRST_WORKSPACE");
      const first = await prepareEmbeddedAttemptBootstrap(params);
      expect(first.contextFiles.some((file) => file.content.includes("FIRST_WORKSPACE"))).toBe(
        true,
      );
      await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "EDITED_WORKSPACE");
      const resumed = await prepareEmbeddedAttemptBootstrap(params);
      expect(resumed.contextFiles.some((file) => file.content.includes("FIRST_WORKSPACE"))).toBe(
        true,
      );
      const cli = await withOwner(() =>
        prepareBootstrapSnapshot({
          target,
          expectedWriterRunId: runId,
          workspaceDir: state.workspaceDir,
          audience: "direct",
          assertCurrent: () => {},
          load: async () => {
            throw new Error("Shared snapshot must not read files again");
          },
          render: (files) => buildBootstrapContextForFiles(files, {}),
        }),
      );
      expect(
        (await withOwner(() => cli.load(false))).contextFiles.some((file) =>
          file.content.includes("FIRST_WORKSPACE"),
        ),
      ).toBe(true);
      const loadWithCliRenderer = () =>
        withOwner(async () => {
          const owner = await prepareBootstrapSnapshot({
            target,
            expectedWriterRunId: runId,
            workspaceDir: state.workspaceDir,
            audience: "direct",
            assertCurrent: () => {},
            load: () =>
              resolveBootstrapContextForRun({
                workspaceDir: state.workspaceDir,
                config,
              }),
            render: (files) => buildBootstrapContextForFiles(files, {}),
          });
          return owner.load(false);
        });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const messageId = await withOwner(() =>
        manager.appendMessageAsync({
          role: "user",
          content: "conversation preserved",
          timestamp: 1,
        }),
      );
      await withOwner(() => manager.appendCompactionAsync("Manual summary", messageId, 100));
      await expect(withOwner(() => cli.load(false, { createIfMissing: false }))).rejects.toThrow(
        "Workspace context snapshot is missing",
      );
      expect(
        (await loadWithCliRenderer()).contextFiles.some((file) =>
          file.content.includes("EDITED_WORKSPACE"),
        ),
      ).toBe(true);
      const afterCompact = await prepareEmbeddedAttemptBootstrap(params);
      expect(
        afterCompact.contextFiles.some((file) => file.content.includes("EDITED_WORKSPACE")),
      ).toBe(true);
      expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
      await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "PROVIDER_COMPACT_WORKSPACE");
      const checkpoint = createAssistant(testModel, []);
      captureOpenAIResponsesCompaction(
        checkpoint,
        { type: "compaction", id: "cmp_fixture", encrypted_content: "synthetic-checkpoint" },
        "retained-users",
        testModel,
      );
      await withOwner(() => manager.appendMessageAsync(checkpoint));
      expect(
        (await loadWithCliRenderer()).contextFiles.some((file) =>
          file.content.includes("PROVIDER_COMPACT_WORKSPACE"),
        ),
      ).toBe(true);
      const afterProviderCompact = await prepareEmbeddedAttemptBootstrap(params);
      expect(
        afterProviderCompact.contextFiles.some((file) =>
          file.content.includes("PROVIDER_COMPACT_WORKSPACE"),
        ),
      ).toBe(true);

      await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "LATEST_WORKSPACE");
      const everyTurn = await prepareEmbeddedAttemptBootstrap({
        ...params,
        attempt: { ...params.attempt, config: {} },
      });
      expect(everyTurn.contextFiles.some((file) => file.content.includes("LATEST_WORKSPACE"))).toBe(
        true,
      );
      const diagnostic = await prepareEmbeddedAttemptBootstrap({
        ...params,
        attempt: { ...params.attempt, sessionPersistence: "detached" },
      });
      expect(
        diagnostic.contextFiles.some((file) => file.content.includes("LATEST_WORKSPACE")),
      ).toBe(true);
      expect(diagnostic.refreshWorkspaceContext).toBeUndefined();
      await expect(
        prepareEmbeddedAttemptBootstrap({
          ...params,
          snapshotTarget: undefined,
          withOwnedTranscriptWrite: undefined,
        }),
      ).rejects.toThrow("require an admitted local embedded transcript owner");
      const customEngine = new LegacyContextEngine();
      Object.defineProperty(customEngine, "info", {
        value: { ...customEngine.info, ownsCompaction: true },
      });
      await expect(
        prepareEmbeddedAttemptBootstrap({
          ...params,
          attempt: { ...params.attempt, contextEngine: customEngine },
        }),
      ).rejects.toThrow("requires built-in embedded compaction");
    } finally {
      admission.close();
    }
  });
});

it.each([false, true])(
  "refreshes before the first automatic-compaction retry (persistFailure=%s)",
  async (persistFailure) => {
    await withOpenClawTestState({ label: "embedded-workspace-auto" }, async (state) => {
      const runId = "workspace-auto";
      const target = {
        agentId: "main",
        sessionId: runId,
        sessionKey: "agent:main:" + runId,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: runId,
        updatedAt: 1,
        activeWriterRunId: runId,
      });
      const config = {
        agents: {
          defaults: {
            workspaceContextRefresh: "compaction" as const,
            contextInjection: "always" as const,
          },
        },
      };
      const admission = prepareSystemAgentRunAdmission(
        config,
        runId,
        "main",
        "workspace-auto-test",
      );
      const admittedRunContext = await admission.admit("embedded");
      const withOwner = <T>(operation: () => Promise<T> | T) =>
        withOwnedSessionTranscriptWrites(
          {
            sessionTarget: { ...target, expectedWriterRunId: runId },
            assertCommitAllowed: () => {},
            withTranscriptWrite: async (write) => await write(),
          },
          operation,
        );
      try {
        await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "PRE_COMPACT_FILES");
        const bootstrap = await prepareEmbeddedAttemptBootstrap({
          attempt: {
            config,
            sessionId: runId,
            sessionKey: target.sessionKey,
            sessionTarget: target,
            runId,
            admittedRunContext,
            operation: "attempt",
            chatType: "direct",
          },
          setup: {
            effectiveWorkspace: state.workspaceDir,
            resolvedWorkspace: state.workspaceDir,
            sessionAgentId: "main",
          },
          snapshotTarget: target,
          isRawModelRun: false,
          hasReadTool: false,
          withOwnedTranscriptWrite: withOwner,
        });
        const render = async () =>
          (
            await buildAttemptSystemPrompt({
              isRawModelRun: false,
              transformSystemPrompt: (text) => text,
              embeddedSystemPrompt: {
                workspaceDir: state.workspaceDir,
                contextFiles: bootstrap.contextFiles,
                extraSystemPrompt: "CURRENT_JOB_INSTRUCTIONS",
                toolNames: ["read"],
                skillsPrompt: "CURRENT_SKILLS",
              },
            })
          ).systemPrompt;
        const handlers = createCompactionHandlers();
        handlers.set("session_before_compact", [
          async (event: unknown) => {
            const { preparation } = event as {
              preparation: { firstKeptEntryId: string; tokensBefore: number };
            };
            return { compaction: { summary: "Automatic summary", ...preparation } };
          },
        ]);
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const { session } = await createTestSession({
          systemPrompt: await render(),
          sessionManager: manager,
          settingsManager: createAutoCompactionSettings(),
          resourceLoader: createResourceLoader(handlers),
          withSessionWriteSettlement: withOwner,
        });
        session[agentSessionSetContextReplacementHook](() =>
          bootstrap.markWorkspaceContextCompacted?.(),
        );
        const requests: string[] = [];
        let restore: (() => void) | undefined;
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(context.systemPrompt ?? "");
          return createAssistantResultStream(
            requests.length === 1
              ? createOverflowAssistant(model)
              : createAssistant(model, [{ type: "text", text: "resumed" }]),
          );
        });
        await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), "POST_COMPACT_FILES");
        if (persistFailure) {
          const spy = vi
            .spyOn(SessionManager.prototype, "appendCustomEntryAsync")
            .mockRejectedValue(new Error("snapshot persistence unavailable"));
          restore = () => spy.mockRestore();
        }
        try {
          await submitEmbeddedAttemptPrompt({
            ...createBaseInput(),
            activeSession: session,
            appendContext: undefined,
            prependContext: undefined,
            modelPrompt: "transcript prompt",
            preparePrimaryModelRequest: async () => {
              if (await bootstrap.refreshWorkspaceContext?.()) {
                session.setBaseSystemPrompt(await render());
              }
              return () => ({
                tools: session.agent.state.tools,
                systemPrompt: session.agent.state.systemPrompt,
              });
            },
            promptActiveSession: (prompt, options) => session.prompt(prompt, options),
          });
        } finally {
          restore?.();
        }
        expect(requests[0]).toContain("PRE_COMPACT_FILES");
        if (persistFailure) {
          expect(requests).toHaveLength(1);
          expect(session.getLastAssistantText()).not.toBe("resumed");
          expect(await bootstrap.refreshWorkspaceContext?.()).toBe(true);
        } else {
          expect(requests).toHaveLength(2);
          expect(requests[1]).toContain("POST_COMPACT_FILES");
          expect(requests[1]).not.toContain("PRE_COMPACT_FILES");
          expect(requests[1]).toContain("CURRENT_JOB_INSTRUCTIONS");
          expect(requests[1]).toContain("CURRENT_SKILLS");
        }
      } finally {
        admission.close();
      }
    });
  },
);
