import { access, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
import { snapshotFiles } from "../../infra/state-migrations.caller-mode.test-helpers.js";
import { autoMigrateLegacyState } from "../../infra/state-migrations.doctor.js";
import { inspectLegacyAgentDir } from "../../infra/state-migrations.legacy-sessions.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../plugins/legacy-session-surfaces.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  noteAuthProfileFileWrite,
  refreshAuthProfileFileState,
} from "../auth-profiles/file-state.js";
import * as migrationDiagnostics from "../auth-profiles/legacy-source-diagnostic.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import {
  readPersistedAuthProfileStoreRaw as readStore,
  writePersistedAuthProfileStoreRaw as writeStore,
} from "../auth-profiles/sqlite.js";
import type { ApiKeyCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { getAgentDir } from "../config.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
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
import { sessionManagerAppendInitialMetadata } from "./session-manager-metadata.js";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "./session-manager-types.js";
import * as writeAdmission from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

describe("SDK credential migration", () => {
  const baseUrl = "https://openrouter.ai/api/v1";
  const directUrl = "https://api.arcee.ai/api/v1";
  const config = { models: { providers: { arcee: { baseUrl, models: [] } } } };
  const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
  const migrationMessage = "requires legacy credential migration";
  const migrationError = { code: "AUTH_PROFILE_MIGRATION_REQUIRED" };

  function apiKeyStore(
    provider: string,
    credential: Pick<ApiKeyCredential, "key" | "keyRef">,
  ): AuthProfileStore {
    return {
      version: 1,
      profiles: { [`${provider}:default`]: { type: "api_key", provider, ...credential } },
    };
  }

  function withAuthState(
    run: (state: OpenClawTestState, agentDir: string) => Promise<void>,
    env?: Record<string, string | undefined>,
  ) {
    return withOpenClawTestState(
      { layout: "state-only", prefix: "sdk-auth-", env },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await mkdir(agentDir, { recursive: true });
        await run(state, agentDir);
      },
    );
  }

  function expectMigrationRequired(ownerDir?: string) {
    expect(() => assertAuthProfileMigrationReady(ownerDir)).toThrow(migrationMessage);
  }

  function expectKey(actual: string | undefined, expected: string) {
    expect(actual === expected, "selected credential belongs to the expected owner").toBe(true);
  }

  async function stageLegacy(
    state: OpenClawTestState,
    legacy: AuthProfileStore,
    ownerDir?: string,
  ) {
    const file = await state.writeJson(
      `agents/${ownerDir ? "worker" : "main"}/agent/auth-profiles.json`,
      legacy,
    );
    writeStore(emptyStore, ownerDir);
    return file;
  }

  async function importLegacy(state: OpenClawTestState, legacy: AuthProfileStore) {
    const file = await stageLegacy(state, legacy);
    expectMigrationRequired();
    writeStore(legacy);
    await rename(file, `${file}.migrated`);
  }

  function authWithFallback(agentDir: string, fallbackKey = "synthetic-other-account-key") {
    const storage = AuthStorage.forAgent(agentDir, config);
    const fallback = vi.fn(() => fallbackKey);
    storage.setFallbackResolver(fallback);
    return { storage, fallback };
  }

  function atCredentialCheck(change: (assertSelected: () => void) => void) {
    const check = migrationDiagnostics.assertAuthProfileCredentialMigrationStateAtDatabasePath;
    vi.spyOn(
      migrationDiagnostics,
      "assertAuthProfileCredentialMigrationStateAtDatabasePath",
    ).mockImplementationOnce((...args) => change(() => check(...args)));
  }

  afterEach(() => {
    clearAuthProfileMigrationDiagnostics();
    vi.restoreAllMocks();
  });

  it("keeps a legacy SDK store when Doctor's configured owner differs", async () => {
    await withOpenClawTestState(
      { label: "sdk-legacy-owner", layout: "home", agentEnv: "clear" },
      async (state) => {
        vi.spyOn(os, "homedir").mockReturnValue(state.home);
        const legacyDir = path.join(state.home, ".openclaw", "agent");
        const databasePath = path.join(legacyDir, "openclaw-agent.sqlite");
        await mkdir(path.join(legacyDir, "bin"), { recursive: true });
        await writeFile(path.join(legacyDir, "bin", "fd"), "installed SDK tool");
        openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: databasePath });
        await closeOpenClawAgentDatabaseByPathAsync(databasePath);
        // The legacy standalone SDK fixture predates registry enrollment.
        unregisterOpenClawAgentDatabase({ agentId: "main", env: state.env, path: databasePath });
        expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
          status: "owned",
          agentId: "main",
        });
        // Payload inspection materializes native WAL sidecars before the snapshot.
        expect(inspectLegacyAgentDir(legacyDir)).toEqual({ status: "payload" });
        const before = snapshotFiles(legacyDir);
        const cfg = { agents: { entries: { worker: {} } }, plugins: { enabled: false } };
        await state.writeConfig(cfg);
        const result = await autoMigrateLegacyState({
          cfg,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(result.stepReceipts.find((entry) => entry.outcome === "refused")).toBeUndefined();
        const receipt = result.stepReceipts.find((entry) => entry.id === "agent-dir");
        expect(receipt).toMatchObject({
          outcome: "deferred",
          deferred: [
            {
              reason: "owner-mismatch",
              recordedOwner: "main",
              configuredOwner: "worker",
              path: legacyDir,
            },
          ],
          warnings: expect.arrayContaining([
            expect.stringContaining("Keep using the existing store"),
          ]),
        });
        expect(snapshotFiles(legacyDir)).toEqual(before);
        await expect(
          access(path.join(state.agentDir("worker"), ".legacy-agent-dir-migration.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(getAgentDir()).toBe(legacyDir);
      },
    );
  });

  it.each([
    ["OpenRouter model override", baseUrl, directUrl, true],
    ["direct Arcee model override", directUrl, baseUrl, false],
  ] as const)(
    "resolves %s before provider dispatch",
    async (_route, modelUrl, configuredUrl, blocked) => {
      await withAuthState(async (state, agentDir) => {
        await stageLegacy(
          state,
          apiKeyStore("openrouter", { key: "synthetic-legacy-key" }),
          agentDir,
        );
        setRuntimeConfigSnapshot({
          models: { providers: { arcee: { baseUrl: configuredUrl, models: [] } } },
        });
        const model = makeProviderModelFixture({
          id: "synthetic-model",
          name: "Synthetic model",
          api: "openai-completions",
          provider: "arcee",
          baseUrl: modelUrl,
          contextWindow: 1000,
          maxTokens: 1000,
        });
        const runtimeConfig = getRuntimeConfig();
        const manager = SessionManager.inMemory();
        const { session } = await createTestSession(manager, manager.getCwd(), {
          modelRegistry: ModelRegistry.create(
            AuthStorage.forAgent(agentDir, runtimeConfig),
            path.join(agentDir, "models.json"),
            { config: runtimeConfig },
          ),
          model,
        });
        const credential = "synthetic-fallback-key";
        const providerIo = vi.fn(() => createAssistantMessageEventStream());
        session.modelRegistry.registerProvider("arcee", {
          api: model.api,
          apiKey: credential,
          streamSimple: providerIo,
        });
        try {
          const stream = session.agent.streamFn;
          if (!stream) {
            throw new Error("SDK stream was not installed");
          }
          const result = Promise.resolve(stream(model, { messages: [] }, {}));
          if (blocked) {
            await expect(result).rejects.toThrow(migrationMessage);
          } else {
            await result;
          }
          expect(providerIo).toHaveBeenCalledTimes(blocked ? 0 : 1);
          if (!blocked) {
            const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
            expect(
              auth.ok && auth.apiKey === credential,
              "direct account credential selected",
            ).toBe(true);
          }
        } finally {
          session.dispose();
        }
      });
    },
  );

  it("refuses an endpoint-dependent facade request without config", async () => {
    await withAuthState(async (state, agentDir) => {
      await stageLegacy(
        state,
        apiKeyStore("openrouter", { key: "synthetic-legacy-key" }),
        agentDir,
      );
      const storage = AuthStorage.forAgent(agentDir);
      const fallback = vi.fn(() => "synthetic-fallback-key");
      storage.setFallbackResolver(fallback);
      await expect(storage.getApiKey("arcee")).rejects.toMatchObject(migrationError);
      expect(fallback).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "local SecretRef across a shared Arcee refusal", secretRef: true, provider: "arcee" },
    {
      name: "unaffected provider beside a shared Arcee refusal",
      secretRef: false,
      provider: "openai",
    },
  ])("preserves $name", async ({ secretRef, provider }) => {
    const localKey = "synthetic-local-account-key";
    const otherKey = "synthetic-other-account-key";
    const unaffectedKey = "synthetic-unaffected-account-key";
    await withAuthState(
      async (state, agentDir) => {
        await state.writeJson(
          "agents/main/agent/auth-profiles.json",
          apiKeyStore("arcee", { key: "synthetic-legacy-key" }),
        );
        writeStore(
          apiKeyStore(
            "arcee",
            secretRef
              ? { keyRef: { source: "env", provider: "default", id: "UNRESOLVED_LOCAL_ARCEE" } }
              : { key: localKey },
          ),
          agentDir,
        );
        const fallback = vi.fn(() => otherKey);
        const resolve = async () => {
          const storage = AuthStorage.forAgent(agentDir, config);
          storage.setFallbackResolver(fallback);
          return await storage.getApiKey(provider, provider === "arcee" ? { baseUrl } : undefined);
        };
        if (secretRef) {
          await expect(resolve()).rejects.toThrow(
            "requires the active secrets runtime to materialize SecretRef credentials",
          );
        } else {
          expectKey(await resolve(), provider === "arcee" ? localKey : unaffectedKey);
        }
        expect(fallback).not.toHaveBeenCalled();
      },
      {
        ARCEEAI_API_KEY: otherKey,
        OPENAI_API_KEY: unaffectedKey,
        UNRESOLVED_LOCAL_ARCEE: undefined,
      },
    );
  });

  it.each(["local", "shared"])(
    "keeps imported %s credentials fenced until lifecycle clear",
    async (owner) => {
      await withAuthState(async (state, agentDir) => {
        const ownerDir = owner === "local" ? agentDir : undefined;
        const legacyPath = `agents/${owner === "local" ? "worker" : "main"}/agent/auth-profiles.json`;
        const importedKey = "synthetic-imported-key";
        const legacy = apiKeyStore("arcee", { key: importedKey });
        const legacyFile = await stageLegacy(state, legacy, ownerDir);
        const { storage, fallback } = authWithFallback(agentDir);
        expectMigrationRequired(ownerDir);
        // Another process's Doctor cannot clear this process's fence.
        writeStore(legacy, ownerDir);
        await rename(legacyFile, `${legacyFile}.migrated`);
        await refreshAuthProfileFileState();
        storage.reload();
        await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject(migrationError);
        expect(fallback).not.toHaveBeenCalled();
        clearAuthProfileMigrationDiagnostics();
        storage.reload();
        expectKey(await storage.getApiKey("arcee", { baseUrl }), importedKey);
        if (owner === "shared") {
          const localKey = "synthetic-new-local-key";
          storage.set("arcee", { type: "api_key", key: localKey });
          expect(readStore(agentDir)).toEqual(apiKeyStore("arcee", { key: localKey }));
          writeStore(emptyStore);
          await state.writeJson(legacyPath, legacy);
          await refreshAuthProfileFileState();
          expectMigrationRequired();
          expectKey(await storage.getApiKey("arcee", { baseUrl }), localKey);
        }
      });
    },
  );

  it("preserves distinct owners for identical imported credential bytes", async () => {
    await withAuthState(
      async (state, agentDir) => {
        const key = "synthetic-same-account-bytes";
        const legacy = apiKeyStore("arcee", { key });
        await importLegacy(state, legacy);
        writeStore(legacy, agentDir);
        const { storage, fallback } = authWithFallback(agentDir);
        expectKey(await storage.getApiKey("arcee", { baseUrl }), key);
        expect(fallback).not.toHaveBeenCalled();
      },
      { UNRESOLVED_IMPORTED_ARCEE: undefined },
    );
  });

  it("rejects imported credentials across a pending unresolved-Ref reload", async () => {
    await withAuthState(
      async (state, agentDir) => {
        await importLegacy(state, apiKeyStore("arcee", { key: "synthetic-imported-key" }));
        const { storage, fallback } = authWithFallback(agentDir);
        let reloadedSelectedCredential = false;
        atCredentialCheck((assertSelected) => {
          writeStore(
            apiKeyStore("arcee", {
              keyRef: { source: "env", provider: "default", id: "UNRESOLVED_IMPORTED_ARCEE" },
            }),
          );
          storage.reload();
          reloadedSelectedCredential = true;
          assertSelected();
        });
        await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject(migrationError);
        expect(reloadedSelectedCredential).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
      },
      { UNRESOLVED_IMPORTED_ARCEE: undefined },
    );
  });

  it("revalidates the selected owner after another reload changes the view", async () => {
    await withAuthState(async (state, agentDir) => {
      const original = apiKeyStore("arcee", { key: "synthetic-shared-key" });
      await state.writeJson("agents/main/agent/auth-profiles.json", original);
      writeStore(original);
      const storage = AuthStorage.forAgent(agentDir, config);
      const localKey = "synthetic-new-local-key";
      let reloadedSelectedCredential = false;
      atCredentialCheck((assertSelected) => {
        assertSelected();
        writeStore(emptyStore);
        expectMigrationRequired();
        writeStore(apiKeyStore("arcee", { key: localKey }), agentDir);
        noteAuthProfileFileWrite(path.join(agentDir, "openclaw-agent.sqlite"));
        storage.reload();
        reloadedSelectedCredential = true;
      });
      await expect(storage.getApiKey("arcee", { baseUrl })).rejects.toMatchObject(migrationError);
      expect(reloadedSelectedCredential).toBe(true);
      expectKey(await storage.getApiKey("arcee", { baseUrl }), localKey);
    });
  });

  it.each([
    { provider: "openai", blocked: false },
    { provider: "openrouter", blocked: true },
  ])("bounds an imported $provider credential's ambiguous realm", async ({ provider, blocked }) => {
    await withAuthState(async (state, agentDir) => {
      const legacyFile = await stageLegacy(
        state,
        apiKeyStore("arcee", { key: "synthetic-legacy-key" }),
      );
      expectMigrationRequired();
      const key = "synthetic-new-account-key";
      writeStore(apiKeyStore(provider, { key }));
      await rename(legacyFile, `${legacyFile}.migrated`);
      const result = AuthStorage.forAgent(agentDir, {}).getApiKey(provider);
      if (blocked) {
        await expect(result).rejects.toMatchObject(migrationError);
      } else {
        expect((await result) === key, "unrelated canonical credential remains usable").toBe(true);
      }
    });
  });
});

function sessionTarget(state: OpenClawTestState, sessionId: string) {
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
}

async function seedTarget(target: ReturnType<typeof sessionTarget>) {
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
}

async function createTestSession(
  sessionManager: SessionManager,
  cwd: string,
  options: Partial<Parameters<typeof createAgentSession>[0]> = {},
) {
  return createAgentSession({
    systemPrompt: "Test session prompt",
    cwd,
    model: testModel,
    thinkingLevel: "medium",
    tools: [],
    modelRegistry: options.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory()),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: options.resourceLoader ?? (await createResourceLoader()),
    ...options,
  });
}

function registryFor(...models: (typeof testModel)[]) {
  const auth = AuthStorage.inMemory();
  auth.setRuntimeApiKey(testModel.provider, "synthetic-sdk-key");
  const registry = ModelRegistry.inMemory(auth);
  registry.registerProvider(testModel.provider, {
    api: testModel.api,
    baseUrl: testModel.baseUrl,
    models: models.map(({ id, name, api, reasoning, input, cost, contextWindow, maxTokens }) => ({
      id,
      name,
      api,
      reasoning,
      input,
      cost,
      contextWindow: contextWindow ?? 32_768,
      maxTokens,
    })),
  });
  return registry;
}

async function rejectedSession(pending: ReturnType<typeof createTestSession>) {
  return pending.then(
    ({ session }) => {
      session.dispose();
      throw new Error("Expected SDK initialization to reject");
    },
    (error: unknown) => error,
  );
}

it("restores prepared session context without waiting for an unrelated database writer", async () => {
  await withOpenClawTestState({ label: "sdk-restored-admission" }, async (state) => {
    const target = sessionTarget(state, "restored");
    await seedTarget(target);
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
    const restored = createTestSession(manager, state.workspaceDir);
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

it.each(["metadata", "context loading"] as const)(
  "rejects SDK exposure after retargeting during %s initialization",
  async (after) => {
    await withOpenClawTestState({ label: `sdk-metadata-${after}` }, async (state) => {
      const original = sessionTarget(state, "sdk-original");
      const replacement = sessionTarget(state, "sdk-replacement");
      await seedTarget(original);
      await seedTarget(replacement);
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
        // Retarget after the real append commits, before the factory exposes its session.
        completed.records = loadTranscriptEventsSync(original);
        completed.watermark = readSessionTranscriptWatermark(original);
        manager.setSessionTarget(replacement);
        return id;
      };
      const appendInitial = manager[sessionManagerAppendInitialMetadata].bind(manager);
      const readInitialContext = manager[sessionManagerReadInitialContext].bind(manager);
      const intercepted =
        after === "metadata"
          ? vi
              .spyOn(manager, sessionManagerAppendInitialMetadata)
              .mockImplementation((provider, modelId, level) =>
                retargetAfterAppend(() => appendInitial(provider, modelId, level)),
              )
          : vi.spyOn(manager, sessionManagerReadInitialContext).mockImplementation(async () => {
              const context = await readInitialContext();
              manager.setSessionTarget(replacement);
              return context;
            });
      onTestFinished(() => intercepted.mockRestore());
      const model = {
        ...testModel,
        id: "sdk-metadata-fixture",
        reasoning: true,
      };
      expect(getOwnedSessionTranscriptWriterFence()).toBeUndefined();

      const error = await rejectedSession(
        createTestSession(manager, state.workspaceDir, {
          model,
          thinkingLevel: "high",
          modelRegistry: registryFor(model),
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
          }),
        }),
      );
      expect(intercepted).toHaveBeenCalledOnce();
      expect.soft(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
      if (after === "context loading") {
        expect(await loadTranscriptEvents(original)).toEqual(originalBefore);
        expect(error).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
        expect(error).not.toBeInstanceOf(SessionMetadataCommittedError);
        expect(hasModelFallbackStop(error)).toBe(false);
      } else {
        expect(completed.entry).toBeDefined();
        expect(completed.records).toHaveLength(3);
        expect(await loadTranscriptEvents(original)).toEqual(completed.records);
        expect(error).toBeInstanceOf(SessionMetadataCommittedError);
        expect(error).toMatchObject({
          committedEntry: completed.entry,
          committedTarget: original,
          committedVersion: {
            generation: completed.watermark?.generation,
            rawSeq: completed.watermark?.maxSeq,
          },
        });
        expect(hasModelFallbackStop(error)).toBe(true);
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
      const target = sessionTarget(state, "bounded-selection");
      await seedTarget(target);
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
      const pending = createTestSession(manager, state.workspaceDir, { thinkingLevel: "off" });
      void pending.catch(() => {});
      try {
        if (timing === "during") {
          const reachedReader = await Promise.race([
            entered.promise.then(() => true),
            pending.then(
              () => false,
              () => false,
            ),
          ]);
          expect(reachedReader, "SDK history completed before the reader pause").toBe(true);
          select();
          release.resolve();
        }
        if (timing === "during") {
          await expect(pending).rejects.toThrow("changed during initial context read");
          expect(manager.getLeafId()).toBe(selection === "branch" ? firstId : null);
          expect(await loadTranscriptEvents(target)).toEqual(before);
        } else {
          const { session } = await pending;
          const expected = selection === "branch" ? [first] : [];
          expect(session.messages).toEqual(expected);
          const next = {
            role: "user" as const,
            content: "Continue selected branch",
            timestamp: 3,
          };
          manager.appendMessage(next);
          expect(manager.buildSessionContext().messages).toEqual([...expected, next]);
          expect((await loadTranscriptEvents(target)).slice(0, before.length)).toEqual(before);
        }
      } finally {
        release.resolve();
        intercepted?.mockRestore();
        await pending.then(
          ({ session }) => session.dispose(),
          () => {},
        );
      }
    });
  },
);

async function createPersistenceExtensionSession(manager: SessionManager, cwd: string) {
  const resourceLoader = await createResourceLoader();
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
  const { session } = await createTestSession(manager, cwd, { resourceLoader });
  if (!loadedApi) {
    throw new Error("Extension API was not loaded");
  }
  return { session, api: loadedApi, runtime: extensions.runtime };
}

it("awaits extension entry, name, and label persistence before publishing their results", async () => {
  await withOpenClawTestState({ label: "extension-awaited-persistence" }, async (state) => {
    const target = sessionTarget(state, "extension-awaited");
    await seedTarget(target);
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

it.each(
  (["persistent", "detached"] as const).flatMap((storage) =>
    (["extension", "session"] as const).map((surface) => ({ storage, surface })),
  ),
)(
  "rejects a queued $storage $surface persistence capability closed before admission",
  async ({ storage, surface }) => {
    await withOpenClawTestState({ label: "extension-persistence-revoked" }, async (state) => {
      const target = sessionTarget(state, "extension-revoked");
      if (storage === "persistent") {
        await seedTarget(target);
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
      const pending =
        surface === "extension"
          ? api.appendEntryAsync("revoked-state", { count: 1 })
          : session.setSessionNameAsync("revoked name");
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
    const target = sessionTarget(state, "name-original");
    const replacement = sessionTarget(state, "name-replacement");
    await seedTarget(target);
    await seedTarget(replacement);
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
      await seedTarget(first);
      await seedTarget(second);
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
        };
        const plainModel = { ...reasoningModel, id: "cwd-plain", reasoning: false };
        const modelRegistry = registryFor(reasoningModel, plainModel);
        const create = async () =>
          createTestSession(manager, firstDir, {
            model: reasoningModel,
            thinkingLevel: "high",
            modelRegistry,
            settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "high" }),
          });
        if (operation === "model transition") {
          session = (await create()).session;
        }
        const append = manager.appendModelChange.bind(manager);
        const appendInitial = manager[sessionManagerAppendInitialMetadata].bind(manager);
        const completed: { records?: Awaited<ReturnType<typeof loadTranscriptEvents>> } = {};
        const changeCwdAfterAppend = async (write: () => Promise<string>) => {
          const id = await write();
          completed.records = loadTranscriptEventsSync(first);
          process.chdir(secondDir);
          return id;
        };
        const intercepted =
          operation === "SDK initialization"
            ? vi
                .spyOn(manager, sessionManagerAppendInitialMetadata)
                .mockImplementation((provider, modelId, level) =>
                  changeCwdAfterAppend(() => appendInitial(provider, modelId, level)),
                )
            : vi
                .spyOn(manager, "appendModelChange")
                .mockImplementation((provider, modelId) =>
                  changeCwdAfterAppend(() => append(provider, modelId)),
                );
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
        if (operation === "SDK initialization") {
          expect.soft(firstAfter).toEqual(completed.records);
        } else {
          expect
            .soft(firstAfter.slice(completed.records?.length))
            .toMatchObject([{ type: "thinking_level_change", thinkingLevel: level }]);
        }
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
