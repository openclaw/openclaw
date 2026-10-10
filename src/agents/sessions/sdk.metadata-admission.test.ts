import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import {
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { testModel } from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import type { ExtensionAPI } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { sessionManagerReadInitialContext } from "./session-manager-current-turn.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "./session-manager-types.js";
import * as writeAdmission from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

it("restores prepared session context without waiting for an unrelated database writer", async () => {
  await withOpenClawTestState({ label: "sdk-restored-admission" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "restored",
      sessionKey: "agent:main:restored",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, state.workspaceDir);
    await manager.appendThinkingLevelChange("off");
    const message = { role: "user" as const, content: "Restore these exact bytes", timestamp: 1 };
    manager.appendMessage(message);
    const before = await loadTranscriptEvents(target);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const writer = runOpenClawAgentWorkerWrite(
      { agentId: "main", path: target.storePath },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    const requestedWrite = createDeferredCore<"writer-admission">();
    const originalWrite = writeAdmission.withSessionManagerWrite;
    const intercepted = vi
      .spyOn(writeAdmission, "withSessionManagerWrite")
      .mockImplementation((writeManager, write) => {
        requestedWrite.resolve("writer-admission");
        return originalWrite(writeManager, write);
      });
    const authStorage = AuthStorage.inMemory();
    const restored = createAgentSession({
      systemPrompt: "Test session prompt",
      cwd: state.workspaceDir,
      model: testModel,
      thinkingLevel: "medium" as const,
      tools: [],
      modelRegistry: ModelRegistry.inMemory(authStorage),
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: createResourceLoader(),
    });
    try {
      expect(await Promise.race([restored.then(() => "ready"), requestedWrite.promise])).toBe(
        "ready",
      );
      const { session } = await restored;
      expect(session.messages).toEqual([message]);
      expect(session.thinkingLevel).toBe("off");
      expect(await loadTranscriptEvents(target)).toEqual(before);
    } finally {
      intercepted.mockRestore();
      release.resolve();
      await writer;
      (await restored).session.dispose();
    }
  });
});

it.each(["model", "thinking", "context loading"] as const)(
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
        // Inspect committed fixture bytes while the SDK still owns metadata admission.
        completed.records = loadTranscriptEventsSync(original);
        completed.watermark = readSessionTranscriptWatermark(original);
        manager.setSessionTarget(replacement);
        return id;
      };
      const appendModel = manager.appendModelChange.bind(manager);
      const appendThinking = manager.appendThinkingLevelChange.bind(manager);
      const readInitialContext = manager[sessionManagerReadInitialContext].bind(manager);
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
            : vi.spyOn(manager, sessionManagerReadInitialContext).mockImplementation(async () => {
                const context = await readInitialContext();
                manager.setSessionTarget(replacement);
                return context;
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
        systemPrompt: "Test session prompt",
        cwd: state.workspaceDir,
        model,
        thinkingLevel: "high",
        tools: [],
        modelRegistry,
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        resourceLoader: createResourceLoader(),
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        expect(intercepted).toHaveBeenCalledOnce();
        if (after === "context loading") {
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

it.each([
  { selection: "branch", timing: "before" },
  { selection: "reset", timing: "before" },
  { selection: "branch", timing: "during" },
] as const)(
  "preserves bounded $selection selection $timing SDK history loading",
  async ({ selection, timing }) => {
    await withOpenClawTestState({ label: "sdk-bounded-selection" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "bounded-selection",
        sessionKey: "agent:main:bounded-selection",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, state.workspaceDir);
      await source.appendThinkingLevelChange("off");
      const first = { role: "user" as const, content: "Selected branch", timestamp: 1 };
      const firstId = source.appendMessage(first);
      source.appendMessage({ role: "user", content: "Other branch", timestamp: 2 });
      const manager = await SessionManager.openBoundedAsync(target, {
        cwd: state.workspaceDir,
        maxBytes: 64_000,
        maxEvents: 20,
      });
      const before = await loadTranscriptEvents(target);
      const select = () => (selection === "branch" ? manager.branch(firstId) : manager.resetLeaf());
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const readContext = contextWorker.readSessionTranscriptModelContextInWorker;
      const intercepted =
        timing === "during"
          ? vi
              .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
              .mockImplementationOnce(async (...args) => {
                const context = await readContext(...args);
                entered.resolve();
                await release.promise;
                return context;
              })
          : undefined;
      if (timing === "before") {
        select();
      }
      const authStorage = AuthStorage.inMemory();
      const pending = createAgentSession({
        systemPrompt: "Test session prompt",
        cwd: state.workspaceDir,
        model: testModel,
        thinkingLevel: "off",
        tools: [],
        modelRegistry: ModelRegistry.inMemory(authStorage),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory(),
        resourceLoader: createResourceLoader(),
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        if (timing === "during") {
          const reachedReader = await Promise.race([
            entered.promise.then(() => true),
            pending.then(() => false),
          ]);
          expect(reachedReader, "SDK history completed before the reader pause").toBe(true);
          select();
          release.resolve();
        }
        const outcome = await pending;
        if (timing === "during") {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") {
            expect(String(outcome.error)).toContain("changed during initial context read");
          }
          expect(manager.getLeafId()).toBe(selection === "branch" ? firstId : null);
          expect(await loadTranscriptEvents(target)).toEqual(before);
        } else {
          expect(outcome.status).toBe("fulfilled");
          if (outcome.status === "fulfilled") {
            const expected = selection === "branch" ? [first] : [];
            expect(outcome.value.session.messages).toEqual(expected);
            const next = {
              role: "user" as const,
              content: "Continue selected branch",
              timestamp: 3,
            };
            manager.appendMessage(next);
            expect(manager.buildSessionContext().messages).toEqual([...expected, next]);
            expect((await loadTranscriptEvents(target)).slice(0, before.length)).toEqual(before);
          }
        }
      } finally {
        release.resolve();
        intercepted?.mockRestore();
        const outcome = await pending;
        if (outcome.status === "fulfilled") {
          outcome.value.session.dispose();
        }
      }
    });
  },
);

async function createPersistenceExtensionSession(manager: SessionManager, cwd: string) {
  const resourceLoader = createResourceLoader();
  const extensions = resourceLoader.getExtensions();
  let loadedApi: ExtensionAPI | undefined;
  extensions.extensions.push(
    await loadExtensionFromFactory(
      (api) => {
        loadedApi = api;
      },
      cwd,
      createEventBus(),
      extensions.runtime,
    ),
  );
  const authStorage = AuthStorage.inMemory();
  const { session } = await createAgentSession({
    systemPrompt: "Test session prompt",
    cwd,
    model: testModel,
    thinkingLevel: "medium" as const,
    tools: [],
    modelRegistry: ModelRegistry.inMemory(authStorage),
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    resourceLoader,
  });
  if (!loadedApi) {
    throw new Error("Extension API was not loaded");
  }
  return { session, api: loadedApi, runtime: extensions.runtime };
}

it("awaits extension entry, name, and label persistence before publishing their results", async () => {
  await withOpenClawTestState({ label: "extension-awaited-persistence" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "extension-awaited",
      sessionKey: "agent:main:extension-awaited",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const { session, api } = await createPersistenceExtensionSession(manager, state.workspaceDir);
    try {
      const changes: string[] = [];
      session.subscribe((event) => {
        if (event.type === "session_info_changed") {
          changes.push(event.name ?? "");
          expect(manager.getSessionName()).toBe(event.name);
        }
      });
      const id = await api.appendEntryAsync("extension-state", { count: 1 });
      await api.setSessionNameAsync("Awaited name");
      await api.setLabelAsync(id, "bookmark");
      expect(manager.getEntry(id)).toMatchObject({
        type: "custom",
        customType: "extension-state",
        data: { count: 1 },
      });
      expect(manager.getLabel(id)).toBe("bookmark");
      expect(changes).toEqual(["Awaited name"]);
      const reopened = await SessionManager.openAsync(target, state.workspaceDir);
      expect(reopened.getEntry(id)).toEqual(manager.getEntry(id));
      expect(reopened.getSessionName()).toBe("Awaited name");
      expect(reopened.getLabel(id)).toBe("bookmark");
    } finally {
      session.dispose();
    }
  });
});

it.each(["persistent", "detached"] as const)(
  "rejects a queued %s extension persistence capability closed before admission",
  async (storage) => {
    await withOpenClawTestState({ label: "extension-persistence-revoked" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "extension-revoked",
        sessionKey: "agent:main:extension-revoked",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      if (storage === "persistent") {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      const manager =
        storage === "persistent"
          ? await SessionManager.openAsync(target, state.workspaceDir)
          : SessionManager.inMemory(state.workspaceDir);
      const { session, api, runtime } = await createPersistenceExtensionSession(
        manager,
        state.workspaceDir,
      );
      const before = manager.getEntries();
      const persistedBefore =
        storage === "persistent" ? await loadTranscriptEvents(target) : undefined;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const writer = writeAdmission.withSessionManagerWrite(manager, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const pending = api.appendEntryAsync("revoked-state", { count: 1 });
      const rejected = expect(pending).rejects.toThrow("extension owner closed");
      runtime.invalidate("extension owner closed");
      release.resolve();
      try {
        await writer;
        await rejected;
        expect(manager.getEntries()).toEqual(before);
        if (storage === "persistent") {
          expect(await loadTranscriptEvents(target)).toEqual(persistedBefore);
        }
        await expect(api.setSessionNameAsync("stale")).rejects.toThrow("extension owner closed");
        await expect(api.setLabelAsync("missing", "stale")).rejects.toThrow(
          "extension owner closed",
        );
      } finally {
        release.resolve();
        await writer;
        session.dispose();
      }
    });
  },
);

it("does not publish a committed session name into a manager retargeted before continuation", async () => {
  await withOpenClawTestState({ label: "session-name-retargeted" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "name-original",
      sessionKey: "agent:main:name-original",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    const replacement = {
      ...target,
      sessionId: "name-replacement",
      sessionKey: "agent:main:name-replacement",
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await replaceSessionEntry(replacement, { sessionId: replacement.sessionId, updatedAt: 1 });
    const replacementManager = await SessionManager.openAsync(replacement, state.workspaceDir);
    await replacementManager.appendSessionInfoAsync("Replacement name");
    const replacementBefore = await loadTranscriptEvents(replacement);
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const { session } = await createPersistenceExtensionSession(manager, state.workspaceDir);
    const committed = createDeferredCore<string>();
    const release = createDeferredCore();
    const append = manager.appendSessionInfoAsync.bind(manager);
    const intercepted = vi
      .spyOn(manager, "appendSessionInfoAsync")
      .mockImplementation(async (name) => {
        const id = await append(name);
        committed.resolve(id);
        await release.promise;
        return id;
      });
    const names: Array<string | undefined> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "session_info_changed") {
        names.push(event.name);
      }
    });
    const renamed = session.setSessionNameAsync("Committed original name");
    try {
      const id = await Promise.race([
        committed.promise,
        renamed.then(() => {
          throw new Error("Session rename returned before the committed append was released");
        }),
      ]);
      await manager.setSessionTargetAsync(replacement);
      expect(session.sessionManager).toBe(manager);
      expect(manager.getSessionName()).toBe("Replacement name");
      release.resolve();
      await expect
        .soft(renamed)
        .rejects.toThrow("Session changed before publishing its display name");
      expect(names).toEqual([]);
      expect(await loadTranscriptEvents(target)).toContainEqual(
        expect.objectContaining({ id, type: "session_info", name: "Committed original name" }),
      );
      expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
    } finally {
      release.resolve();
      await Promise.allSettled([renamed]);
      intercepted.mockRestore();
      unsubscribe();
      session.dispose();
    }
  });
});

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
            systemPrompt: "Test session prompt",
            cwd: firstDir,
            sessionManager: manager,
            model: reasoningModel,
            thinkingLevel: "high",
            modelRegistry,
            tools: [],
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
            completed.records = loadTranscriptEventsSync(first);
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
