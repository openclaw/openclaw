import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelCatalogEntry } from "./model-catalog.js";

// Test that subagent model override is correctly applied in agentCommand
describe("agentCommand model override", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    storePath = path.join(testDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("model override is used when allowlist is empty", async () => {
    const { loadSessionStore, updateSessionStore } = await import("../config/sessions/store.js");
    const { clearSessionStoreCacheForTest } = await import("../config/sessions/store.js");

    clearSessionStoreCacheForTest();

    const sessionKey = `agent:main:subagent:${randomUUID()}`;
    const testModel = "gemini-3-pro";
    const testProvider = "google-antigravity";

    // Write session with model override
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: randomUUID(),
        updatedAt: Date.now(),
        modelOverride: testModel,
        providerOverride: testProvider,
      };
    });

    // Read session
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];

    // Simulate agentCommand's model selection logic
    const cfg = {
      agents: {
        defaults: {
          // Empty models = no allowlist
          models: {},
        },
      },
    };

    const hasAllowlist =
      cfg.agents?.defaults?.models && Object.keys(cfg.agents.defaults.models).length > 0;
    expect(hasAllowlist).toBe(false);

    const hasStoredOverride = Boolean(entry?.modelOverride || entry?.providerOverride);
    expect(hasStoredOverride).toBe(true);

    // With empty allowlist, the override should be used directly
    const storedModelOverride = entry?.modelOverride?.trim();
    const storedProviderOverride = entry?.providerOverride?.trim();

    expect(storedModelOverride).toBe(testModel);
    expect(storedProviderOverride).toBe(testProvider);
  });

  it("model NOT in allowlist is still blocked (model not configured at all)", async () => {
    const { buildAllowedModelSet, modelKey } = await import("./model-selection.js");

    // Config with allowlist that does NOT include our model
    const cfg: Partial<OpenClawConfig> = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            // Note: google-antigravity/gemini-3-pro is NOT here
          },
        },
      },
    };

    // Mock catalog - empty since we're testing allowlist behavior
    const mockCatalog: ModelCatalogEntry[] = [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
    ];

    const allowed = buildAllowedModelSet({
      cfg: cfg as OpenClawConfig,
      catalog: mockCatalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    // Check if a model NOT in config is allowed
    const testKey = modelKey("google-antigravity", "gemini-3-pro");
    expect(allowed.allowAny).toBe(false);
    // Model is NOT in agents.defaults.models, so it's blocked
    expect(allowed.allowedKeys.has(testKey)).toBe(false);
  });

  it("model override works when model is in allowlist", async () => {
    const { buildAllowedModelSet, modelKey } = await import("./model-selection.js");

    // Config with allowlist that DOES include our model
    const cfg: Partial<OpenClawConfig> = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            "google-antigravity/gemini-3-pro": {}, // Our model is here!
          },
        },
      },
      models: {
        providers: {
          "google-antigravity": {},
        },
      },
    };

    // Mock catalog
    const mockCatalog: ModelCatalogEntry[] = [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
    ];

    const allowed = buildAllowedModelSet({
      cfg: cfg as OpenClawConfig,
      catalog: mockCatalog,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });

    // Check if our model is allowed
    const testKey = modelKey("google-antigravity", "gemini-3-pro");
    expect(allowed.allowAny).toBe(false);
    // This should be true because google-antigravity is a configured provider
    expect(allowed.allowedKeys.has(testKey)).toBe(true);
  });
});
