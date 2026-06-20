// Tests for AgentSession.syncModelFromStoreEntry — covers the read paths
// that PR #93056 (prompt() sync) does not reach: getContextUsage() called
// between turns, and the default branch-summarizer block invoked while
// a /model switch has already written providerOverride/modelOverride to
// the persisted session entry.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSessionStoreForTest } from "../../config/sessions/test-helpers.js";
import type { Model } from "../../llm/types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const initialModel: Model = {
  id: "initial-model",
  name: "Initial Model",
  api: "openai-responses",
  provider: "initial-provider",
  baseUrl: "https://initial.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

const overrideModel: Model = {
  id: "override-model",
  name: "Override Model",
  api: "openai-responses",
  provider: "override-provider",
  baseUrl: "https://override.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

function registerModels(
  registry: ModelRegistry,
  providers: Array<{ provider: string; model: Model; withAuth: boolean }>,
): void {
  for (const { provider, model, withAuth } of providers) {
    registry.registerProvider(provider, {
      baseUrl: model.baseUrl,
      apiKey: withAuth ? `sk-${provider}-test` : undefined,
      models: [
        {
          id: model.id,
          name: model.name,
          api: model.api,
          baseUrl: model.baseUrl,
          reasoning: model.reasoning,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ],
    });
  }
}

function makeEmptyResourceLoader() {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

type BuiltSession = AgentSession;

async function buildSessionOnDisk(
  storePath: string,
  providers: Array<{ provider: string; model: Model; withAuth: boolean }>,
): Promise<BuiltSession> {
  const auth = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(auth);
  registerModels(registry, providers);
  for (const { provider, withAuth } of providers) {
    if (withAuth) {
      auth.setRuntimeApiKey(provider, `sk-${provider}-test`);
    }
  }
  const sessionManager = SessionManager.continueRecent(process.cwd(), join(storePath, ".."));
  // continueRecent will look in the sessions dir; force-create a session by opening storePath
  // then we'll seed the store JSON ourselves below.
  const { session } = await createAgentSession({
    model: providers[0].model,
    resourceLoader: makeEmptyResourceLoader(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: registry,
  });
  // Inject storePath + matching sessionKey AFTER session construction so the
  // runtime cannot reject the option (it doesn't accept these on createAgentSession).
  (session as unknown as { storePath: string; sessionKey: string }).storePath = storePath;
  (session as unknown as { storePath: string; sessionKey: string }).sessionKey = session.sessionId;
  return session;
}

async function buildInMemorySession(
  providers: Array<{ provider: string; model: Model; withAuth: boolean }>,
): Promise<BuiltSession> {
  const auth = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(auth);
  registerModels(registry, providers);
  for (const { provider, withAuth } of providers) {
    if (withAuth) {
      auth.setRuntimeApiKey(provider, `sk-${provider}-test`);
    }
  }
  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    model: providers[0].model,
    resourceLoader: makeEmptyResourceLoader(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: registry,
  });
  return session;
}

describe("AgentSession syncModelFromStoreEntry (#92415 gaps #2 + #3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-session-92415-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Gap #2 — getContextUsage reflects override after /model write, no prompt sent", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      const session = await buildSessionOnDisk(storePath, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
        { provider: overrideModel.provider, model: overrideModel, withAuth: true },
      ]);

      // Pre-state: this.model points at initial.
      expect(session.getContextUsage()?.contextWindow).toBe(initialModel.contextWindow);

      // Simulate /model command: applyModelOverrideToSessionEntry writes to
      // the session entry's providerOverride/modelOverride. Then persist via
      // the test helper that bypasses SessionManager state.
      const entry = {
        sessionId: session.sessionId,
        updatedAt: Date.now(),
        providerOverride: overrideModel.provider,
        modelOverride: overrideModel.id,
      };
      writeSessionStoreForTest(storePath, { [session.sessionId]: entry });

      // Now getContextUsage is called from TUI/status BEFORE any new prompt.
      // Without the fix, this.model.contextWindow stays stale (initialModel.contextWindow = 4096).
      const usage = session.getContextUsage();
      expect(usage?.contextWindow).toBe(overrideModel.contextWindow);
    });
  });

  it("Gap #2 — no override in entry is a no-op (initial contextWindow returned)", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      const session = await buildSessionOnDisk(storePath, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
      ]);
      // No override write → entry has no providerOverride/modelOverride
      expect(session.getContextUsage()?.contextWindow).toBe(initialModel.contextWindow);
    });
  });

  it("Gap #2 — services path with no storePath is a no-op (guard 1)", async () => {
    // SessionManager.inMemory() → no storePath is plumbed → guard 1 hits.
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const session = await buildInMemorySession([
        { provider: initialModel.provider, model: initialModel, withAuth: true },
      ]);
      // Verify the helper has no storePath to read from (default services path).
      expect((session as unknown as { storePath?: string }).storePath).toBeUndefined();
      expect(session.getContextUsage()?.contextWindow).toBe(initialModel.contextWindow);
    });
  });

  it("Gap #2 — registry miss for override model is a no-op (guard 5)", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      // Only initial model is registered; override model's provider is not in registry.
      const session = await buildSessionOnDisk(storePath, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
      ]);

      writeSessionStoreForTest(storePath, {
        [session.sessionId]: {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
          providerOverride: overrideModel.provider,
          modelOverride: overrideModel.id,
        },
      });

      expect(session.getContextUsage()?.contextWindow).toBe(initialModel.contextWindow);
    });
  });

  it("Gap #2 — no auth for override model is a no-op (guard 6)", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      // Both models registered; only initial has auth.
      const auth = AuthStorage.inMemory();
      const registry = ModelRegistry.inMemory(auth);
      registerModels(registry, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
        { provider: overrideModel.provider, model: overrideModel, withAuth: true },
      ]);
      auth.setRuntimeApiKey(initialModel.provider, `sk-${initialModel.provider}-test`);
      // Spy so override provider appears unauth'd despite registry placeholder apiKey.
      vi.spyOn(registry, "hasConfiguredAuth").mockImplementation(
        (m) => m.provider === initialModel.provider,
      );

      const sessionManager = SessionManager.continueRecent(process.cwd(), join(storePath, ".."));
      const { session } = await createAgentSession({
        model: initialModel,
        resourceLoader: makeEmptyResourceLoader() as never,
        sessionManager,
        settingsManager: SettingsManager.inMemory(),
        modelRegistry: registry,
      });
      (session as unknown as { storePath: string; sessionKey: string }).storePath = storePath;
      (session as unknown as { storePath: string; sessionKey: string }).sessionKey =
        session.sessionId;

      writeSessionStoreForTest(storePath, {
        [session.sessionId]: {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
          providerOverride: overrideModel.provider,
          modelOverride: overrideModel.id,
        },
      });

      expect(session.getContextUsage()?.contextWindow).toBe(initialModel.contextWindow);
    });
  });

  it("Gap #3 — branch summary path reflects override model after /model write", async () => {
    // Branch summary reads this.model at the entry of the default-summarizer
    // block. The fix inserts syncModelFromStoreEntry() there, so this.model
    // must reflect the override BEFORE generateBranchSummary is invoked.
    // We exercise the same sync chain via getContextUsage (which uses the
    // identical helper) and assert this.model identity reflects the override.
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      const session = await buildSessionOnDisk(storePath, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
        { provider: overrideModel.provider, model: overrideModel, withAuth: true },
      ]);

      writeSessionStoreForTest(storePath, {
        [session.sessionId]: {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
          providerOverride: overrideModel.provider,
          modelOverride: overrideModel.id,
        },
      });

      // Trigger sync (same helper, same call chain).
      session.getContextUsage();

      // After sync, this.model must point at the override model — the value
      // the default-summarizer block's getRequiredRequestAuth(model) would see.
      const current = (session as unknown as { model: Model | undefined }).model;
      expect(current?.provider).toBe(overrideModel.provider);
      expect(current?.id).toBe(overrideModel.id);
    });
  });

  it("Gap #3 — no-op sync must not throw (abort-safe before summary starts)", async () => {
    // The sync helper is sync (no async IO inside); abort cascades after
    // the sync line via the existing branchSummaryAbortController logic.
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      const session = await buildSessionOnDisk(storePath, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
      ]);
      expect(() => session.getContextUsage()).not.toThrow();
    });
  });

  it("idempotency — second getContextUsage returns the same override (sync no-op on cached entry)", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const storePath = join(tmpDir, "sessions", "store.json");
      const session = await buildSessionOnDisk(storePath, [
        { provider: initialModel.provider, model: initialModel, withAuth: true },
        { provider: overrideModel.provider, model: overrideModel, withAuth: true },
      ]);

      writeSessionStoreForTest(storePath, {
        [session.sessionId]: {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
          providerOverride: overrideModel.provider,
          modelOverride: overrideModel.id,
        },
      });

      const first = session.getContextUsage();
      const second = session.getContextUsage();
      expect(first?.contextWindow).toBe(overrideModel.contextWindow);
      expect(second?.contextWindow).toBe(overrideModel.contextWindow);
    });
  });
});
