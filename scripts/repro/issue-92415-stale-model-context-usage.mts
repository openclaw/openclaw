#!/usr/bin/env node
/**
 * Live repro for issue #92415 gap #2 — getContextUsage() must reflect the
 * override model that /model wrote to the JSON session store before any new
 * prompt is sent. Run with:
 *   pnpm exec tsx scripts/repro/issue-92415-stale-model-context-usage.mts
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-92415-context-"));
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

// Inject storePath/sessionKey after creation so the test simulates the embedded
// runner's plumbing of these fields.
(session as unknown as { storePath: string; sessionKey: string }).storePath = storePath;
(session as unknown as { storePath: string; sessionKey: string }).sessionKey = session.sessionId;

// Pre-state: simulate /model command → write providerOverride/modelOverride
// directly into the JSON session store (this is what replaceSessionEntry does).
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

// /status calls getContextUsage() — TUI displays stale 4096 before the fix.
const usage = session.getContextUsage();

console.log("=== Issue #92415 gap #2 — getContextUsage stale model ===");
console.log(`initial.contextWindow  = ${initialModel.contextWindow}`);
console.log(`override.contextWindow = ${overrideModel.contextWindow}`);
console.log(`getContextUsage()      = ${usage?.contextWindow ?? "(undefined)"}`);

const passed = usage?.contextWindow === overrideModel.contextWindow;
console.log(passed ? "PASS: getContextUsage reflects override" : "FAIL: getContextUsage is stale");

fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(passed ? 0 : 1);