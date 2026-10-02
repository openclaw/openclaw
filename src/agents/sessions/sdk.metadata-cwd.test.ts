import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { testModel } from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

it.each(["SDK initialization", "model transition"] as const)(
  "%s keeps relative-target metadata on its originally admitted physical database",
  async (operation) => {
    await withOpenClawTestState({ label: "metadata-relative-target" }, async (state) => {
      const originalCwd = process.cwd();
      const firstDir = state.path("cwd-a");
      const secondDir = state.path("cwd-b");
      await mkdir(firstDir, { recursive: true });
      await mkdir(secondDir, { recursive: true });
      const relativeTarget = {
        agentId: "main",
        sessionId: "relative-session",
        sessionKey: "agent:main:relative-session",
        storePath: "session-store.sqlite",
      };
      const first = { ...relativeTarget, storePath: path.join(firstDir, relativeTarget.storePath) };
      const second = {
        ...relativeTarget,
        storePath: path.join(secondDir, relativeTarget.storePath),
      };
      await replaceSessionEntry(first, { sessionId: first.sessionId, updatedAt: 1 });
      await replaceSessionEntry(second, { sessionId: second.sessionId, updatedAt: 1 });
      SessionManager.open(second, secondDir).appendMessage({
        role: "user",
        content: "Leave the other physical database unchanged",
        timestamp: 1,
      });
      const secondBefore = await loadTranscriptEvents(second);
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let restoreAppend: (() => void) | undefined;
      try {
        process.chdir(firstDir);
        const manager = SessionManager.open(relativeTarget, firstDir);
        const capturedTarget = manager.getSessionTarget();
        const reasoningModel = {
          ...testModel,
          id: "cwd-reasoning",
          reasoning: true,
          contextWindow: 32_768,
          maxTokens: 8_192,
        };
        const plainModel = { ...reasoningModel, id: "cwd-plain", reasoning: false };
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(testModel.provider, "synthetic-cwd-key");
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        modelRegistry.registerProvider(testModel.provider, {
          api: testModel.api,
          baseUrl: testModel.baseUrl,
          models: [reasoningModel, plainModel],
        });
        const create = () =>
          createAgentSession({
            cwd: firstDir,
            agentDir: state.agentDir("main"),
            sessionManager: manager,
            model: reasoningModel,
            thinkingLevel: "high",
            authStorage,
            modelRegistry,
            noTools: "all",
            settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "high" }),
            resourceLoader: createResourceLoader(),
          });
        if (operation === "model transition") {
          session = (await create()).session;
        }
        const append = manager.appendModelChange.bind(manager);
        const completed: { records?: Awaited<ReturnType<typeof loadTranscriptEvents>> } = {};
        const intercepted = vi
          .spyOn(manager, "appendModelChange")
          .mockImplementation(async (provider, modelId) => {
            const id = await append(provider, modelId);
            completed.records = await loadTranscriptEvents(first);
            process.chdir(secondDir);
            return id;
          });
        restoreAppend = () => intercepted.mockRestore();
        if (operation === "SDK initialization") {
          session = (await create()).session;
        } else {
          if (!session) {
            throw new Error("Expected the initialized AgentSession fixture");
          }
          await session.setModel(plainModel);
        }

        expect(intercepted).toHaveBeenCalledOnce();
        expect(completed.records).toBeDefined();
        expect(process.cwd()).toBe(secondDir);
        const expectedTarget = { ...first, env: { OPENCLAW_STATE_DIR: state.stateDir } };
        expect.soft(capturedTarget).toEqual(expectedTarget);
        expect.soft(manager.getSessionTarget()).toEqual(expectedTarget);
        expect(manager.getSessionId()).toBe(relativeTarget.sessionId);
        const firstAfter = await loadTranscriptEvents(first);
        expect(firstAfter.slice(0, completed.records?.length)).toEqual(completed.records);
        const level = operation === "SDK initialization" ? "high" : "off";
        expect
          .soft(firstAfter.slice(completed.records?.length))
          .toMatchObject([{ type: "thinking_level_change", thinkingLevel: level }]);
        expect.soft(await loadTranscriptEvents(second)).toEqual(secondBefore);
        expect(session?.thinkingLevel).toBe(level);
      } finally {
        process.chdir(originalCwd);
        restoreAppend?.();
        session?.dispose();
      }
    });
  },
);
