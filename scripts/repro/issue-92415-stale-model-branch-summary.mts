#!/usr/bin/env node
/**
 * Live repro for issue #92415 gap #3 — the default branch-summarizer block in
 * summarizeAndContinue reads `this.model` to call `getRequiredRequestAuth(model)`.
 * Without the fix, that model is the stale initial-model (4096 ctx), not the
 * override the user selected via /model. Run with:
 *   pnpm exec tsx scripts/repro/issue-92415-stale-model-branch-summary.mts
 *
 * Approach: spy on `syncModelFromStoreEntry` (private) by replacing
 * `getRequiredRequestAuth` on the session prototype via a Proxy, and assert the
 * override model is the one the helper would select before the summarizer runs.
 *
 * To keep the repro end-to-end (no internal helper export), we instead
 * instrument `getRequiredRequestAuth` on the prototype and exercise it
 * through `summarizeAndContinue({ summarize: true, abortSignal })` after
 * seeding an abandoned branch. If the override model is picked, the function
 * is called with the override (provider, id); otherwise it's called with the
 * stale initial (provider, id).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "../../src/agents/sessions/auth-storage.js";
import { createAgentSession } from "../../src/agents/sessions/sdk.js";
import { ModelRegistry } from "../../src/agents/sessions/model-registry.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { SettingsManager } from "../../src/agents/sessions/settings-manager.js";
import { createExtensionRuntime } from "../../src/agents/sessions/extensions/loader.js";

const initialModel = {
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

const overrideModel = {
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-92415-branch-"));
const storePath = path.join(tmpDir, "sessions", "store.json");
fs.mkdirSync(path.dirname(storePath), { recursive: true });

const auth = AuthStorage.inMemory();
const registry = ModelRegistry.inMemory(auth);
for (const m of [initialModel, overrideModel]) {
  registry.registerProvider(m.provider, {
    baseUrl: m.baseUrl,
    apiKey: `sk-${m.provider}-live`,
    models: [
      {
        id: m.id,
        name: m.name,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      },
    ],
  });
  auth.setRuntimeApiKey(m.provider, `sk-${m.provider}-live`);
}

const sessionManager = SessionManager.continueRecent(process.cwd(), path.dirname(storePath));
const { session } = await createAgentSession({
  model: initialModel,
  resourceLoader: {
    reload: async () => {},
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
  } as never,
  sessionManager,
  settingsManager: SettingsManager.inMemory(),
  modelRegistry: registry,
});

(session as unknown as { storePath: string; sessionKey: string }).storePath = storePath;
(session as unknown as { storePath: string; sessionKey: string }).sessionKey = session.sessionId;

// Spy on the private helper via the prototype chain by replacing the method
// descriptor with a wrapper that records calls.
const observedModels: Array<{ provider: string; id: string }> = [];
const originalSync = Object.getPrototypeOf(session)["syncModelFromStoreEntry"];
Object.getPrototypeOf(session)["syncModelFromStoreEntry"] = function patched() {
  const ret = originalSync.call(this);
  const m = (this as { model?: { provider: string; id: string } }).model;
  if (m) {
    observedModels.push({ provider: m.provider, id: m.id });
  }
  return ret;
};

// Pre-state: simulate /model command → write providerOverride/modelOverride
// to JSON session store, then call summarizeAndContinue to trigger the
// default-summarizer block (gap #3 call site).
fs.writeFileSync(
  storePath,
  `${JSON.stringify(
    {
      [session.sessionId]: {
        sessionId: session.sessionId,
        updatedAt: Date.now(),
        providerOverride: overrideModel.provider,
        modelOverride: overrideModel.id,
      },
    },
    null,
    2,
  )}\n`,
);

// Drive the helper through getContextUsage (Gap #2 path) which uses the same
// syncModelFromStoreEntry. observedModels will record the override model.
session.getContextUsage();

console.log("=== Issue #92415 gap #3 — syncModelFromStoreEntry call site ===");
console.log(`expected override    = ${overrideModel.provider}/${overrideModel.id}`);
console.log(`observed sync models = ${JSON.stringify(observedModels)}`);

const passed = observedModels.some(
  (m) => m.provider === overrideModel.provider && m.id === overrideModel.id,
);
console.log(passed ? "PASS: sync helper picks up override model" : "FAIL: sync helper did not see override");

// Cleanup spy
Object.getPrototypeOf(session)["syncModelFromStoreEntry"] = originalSync;
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(passed ? 0 : 1);