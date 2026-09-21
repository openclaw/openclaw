import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { testModel } from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "./session-manager-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

it.each(["model", "thinking", "resource loading"] as const)(
  "rejects SDK exposure after retargeting during %s initialization",
  async (after) => {
    await withOpenClawTestState({ label: `sdk-metadata-${after}` }, async (state) => {
      const original = {
        agentId: "main",
        sessionId: "sdk-original",
        sessionKey: "agent:main:sdk-original",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      const replacement = {
        ...original,
        sessionId: "sdk-replacement",
        sessionKey: "agent:main:sdk-replacement",
      };
      await replaceSessionEntry(original, { sessionId: original.sessionId, updatedAt: 1 });
      await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
      SessionManager.open(replacement, state.workspaceDir).appendMessage({
        role: "user",
        content: "Preserve replacement history",
        timestamp: 1,
      });
      const replacementBefore = await loadTranscriptEvents(replacement);
      const originalBefore = await loadTranscriptEvents(original);
      const contextPath = path.join(state.workspaceDir, "AGENTS.md");
      const contextContent = "Synthetic default-loader admission fixture";
      if (after === "resource loading") {
        await writeFile(contextPath, contextContent);
      }
      const manager = SessionManager.open(original, state.workspaceDir);
      const completed: {
        entry?: ModelChangeEntry | ThinkingLevelChangeEntry;
        records?: Awaited<ReturnType<typeof loadTranscriptEvents>>;
        watermark?: ReturnType<typeof readSessionTranscriptWatermark>;
      } = {};
      const retargetAfterAppend = async (append: () => Promise<string>) => {
        const id = await append();
        const entry = manager.getEntry(id);
        if (!entry || (entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
          throw new Error("Expected the real append's committed metadata entry");
        }
        completed.entry = structuredClone(entry);
        completed.records = await loadTranscriptEvents(original);
        completed.watermark = readSessionTranscriptWatermark(original);
        manager.setSessionTarget(replacement);
        return id;
      };
      const appendModel = manager.appendModelChange.bind(manager);
      const appendThinking = manager.appendThinkingLevelChange.bind(manager);
      // Preserve the real method and invoke it with each actual loader receiver below.
      // oxlint-disable-next-line typescript/unbound-method
      const reload = DefaultResourceLoader.prototype.reload;
      const intercepted =
        after === "model"
          ? vi
              .spyOn(manager, "appendModelChange")
              .mockImplementation((provider, modelId) =>
                retargetAfterAppend(() => appendModel(provider, modelId)),
              )
          : after === "thinking"
            ? vi
                .spyOn(manager, "appendThinkingLevelChange")
                .mockImplementation((level) => retargetAfterAppend(() => appendThinking(level)))
            : vi
                .spyOn(DefaultResourceLoader.prototype, "reload")
                .mockImplementation(async function (this: DefaultResourceLoader) {
                  await reload.call(this);
                  expect(this.getAgentsFiles().agentsFiles).toContainEqual({
                    path: contextPath,
                    content: contextContent,
                  });
                  manager.setSessionTarget(replacement);
                });
      const model = {
        ...testModel,
        id: "sdk-metadata-fixture",
        reasoning: true,
        contextWindow: 32_768,
        maxTokens: 8_192,
      };
      const authStorage = AuthStorage.inMemory();
      authStorage.setRuntimeApiKey(model.provider, "synthetic-sdk-key");
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      modelRegistry.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        models: [model],
      });
      expect(getOwnedSessionTranscriptWriterFence()).toBeUndefined();

      const outcome = await createAgentSession({
        cwd: state.workspaceDir,
        agentDir: state.agentDir("main"),
        model,
        thinkingLevel: "high",
        noTools: "all",
        authStorage,
        modelRegistry,
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        ...(after === "resource loading" ? {} : { resourceLoader: createResourceLoader() }),
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        expect(intercepted).toHaveBeenCalledOnce();
        if (after === "resource loading") {
          expect(await loadTranscriptEvents(original)).toEqual(originalBefore);
          expect.soft(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
          expect.soft(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") {
            expect(outcome.error).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
            expect(outcome.error).not.toBeInstanceOf(SessionMetadataCommittedError);
            expect(hasModelFallbackStop(outcome.error)).toBe(false);
          }
          return;
        }
        expect(completed.entry).toBeDefined();
        expect(completed.records).toHaveLength(after === "model" ? 2 : 3);
        expect(await loadTranscriptEvents(original)).toEqual(completed.records);
        expect.soft(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
        expect.soft(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(outcome.error).toBeInstanceOf(SessionMetadataCommittedError);
          expect(outcome.error).toMatchObject({
            committedEntry: completed.entry,
            committedTarget: original,
            committedVersion: {
              generation: completed.watermark?.generation,
              rawSeq: completed.watermark?.maxSeq,
            },
          });
          expect(hasModelFallbackStop(outcome.error)).toBe(true);
        }
      } finally {
        intercepted.mockRestore();
        if (outcome.status === "fulfilled") {
          outcome.value.session.dispose();
        }
      }
    });
  },
);
