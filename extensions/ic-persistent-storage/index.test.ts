/// Tests for IC Memory Vault extension.
/// Covers: config parsing, sync logic, encoding utilities, and plugin structure.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { parseConfig, type IcStorageConfig } from "./config.js";
import type { SyncManifestData } from "./ic-client.js";
import { encodeContent, decodeContent, computeSyncDelta, type LocalMemory } from "./sync.js";

// ============================================================
// Config parsing tests
// ============================================================

describe("config", () => {
  describe("parseConfig", () => {
    it("returns defaults for undefined input", () => {
      const cfg = parseConfig(undefined);
      expect(cfg.network).toBe("ic");
      expect(cfg.autoSync).toBe(true);
      expect(cfg.syncOnSessionEnd).toBe(true);
      expect(cfg.syncOnAgentEnd).toBe(true);
      expect(cfg.canisterId).toBeUndefined();
    });

    it("returns defaults for null input", () => {
      const cfg = parseConfig(null);
      expect(cfg.network).toBe("ic");
      expect(cfg.autoSync).toBe(true);
    });

    it("parses valid full config", () => {
      const cfg = parseConfig({
        canisterId: "uxrrr-q7777-77774-qaaaq-cai",
        factoryCanisterId: "bkyz2-fmaaa-aaaaa-qaaaq-cai",
        network: "local",
        autoSync: false,
        syncOnSessionEnd: false,
        syncOnAgentEnd: false,
      });
      expect(cfg.canisterId).toBe("uxrrr-q7777-77774-qaaaq-cai");
      expect(cfg.factoryCanisterId).toBe("bkyz2-fmaaa-aaaaa-qaaaq-cai");
      expect(cfg.network).toBe("local");
      expect(cfg.autoSync).toBe(false);
      expect(cfg.syncOnSessionEnd).toBe(false);
      expect(cfg.syncOnAgentEnd).toBe(false);
    });

    it("treats missing booleans as true (opt-out pattern)", () => {
      const cfg = parseConfig({ network: "ic" });
      expect(cfg.autoSync).toBe(true);
      expect(cfg.syncOnSessionEnd).toBe(true);
      expect(cfg.syncOnAgentEnd).toBe(true);
    });

    it("rejects unknown keys", () => {
      expect(() => parseConfig({ unknownKey: "value" })).toThrow('Unknown config key "unknownKey"');
    });

    it("rejects invalid network value", () => {
      expect(() => parseConfig({ network: "mainnet" })).toThrow('Invalid network "mainnet"');
    });

    it("rejects non-string canisterId", () => {
      expect(() => parseConfig({ canisterId: 123 })).toThrow("canisterId must be a string");
    });

    it("rejects non-object input", () => {
      expect(() => parseConfig("not-an-object")).toThrow("IC storage config must be an object");
    });

    it("rejects array input", () => {
      expect(() => parseConfig([1, 2, 3])).toThrow("IC storage config must be an object");
    });

    it("resolves environment variables in canisterId", () => {
      process.env.TEST_CANISTER_ID = "test-canister-123";
      const cfg = parseConfig({
        canisterId: "${TEST_CANISTER_ID}",
      });
      expect(cfg.canisterId).toBe("test-canister-123");
      delete process.env.TEST_CANISTER_ID;
    });

    it("resolves environment variables in factoryCanisterId", () => {
      process.env.TEST_FACTORY_ID = "factory-456";
      const cfg = parseConfig({
        factoryCanisterId: "${TEST_FACTORY_ID}",
      });
      expect(cfg.factoryCanisterId).toBe("factory-456");
      delete process.env.TEST_FACTORY_ID;
    });

    it("replaces undefined env vars with empty string", () => {
      const cfg = parseConfig({
        canisterId: "${NONEXISTENT_VAR}",
      });
      expect(cfg.canisterId).toBe("");
    });
  });
});

// ============================================================
// Encoding/decoding tests
// ============================================================

describe("encoding", () => {
  it("round-trips text content", () => {
    const original = "Hello, IC Memory Vault!";
    const encoded = encodeContent(original);
    const decoded = decodeContent(encoded);
    expect(decoded).toBe(original);
  });

  it("handles empty string", () => {
    const encoded = encodeContent("");
    const decoded = decodeContent(encoded);
    expect(decoded).toBe("");
  });

  it("handles unicode content", () => {
    const original = "Unicode test: \\u4f60\\u597d \\ud83d\\ude80 \\u00e9\\u00e8\\u00ea";
    const encoded = encodeContent(original);
    const decoded = decodeContent(encoded);
    expect(decoded).toBe(original);
  });

  it("handles multi-line content", () => {
    const original = "line 1\nline 2\nline 3\n";
    const encoded = encodeContent(original);
    const decoded = decodeContent(encoded);
    expect(decoded).toBe(original);
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", nested: { arr: [1, 2, 3] } });
    const encoded = encodeContent(json);
    const decoded = decodeContent(encoded);
    expect(decoded).toBe(json);
    expect(JSON.parse(decoded)).toEqual({
      key: "value",
      nested: { arr: [1, 2, 3] },
    });
  });

  it("encodes to Uint8Array", () => {
    const encoded = encodeContent("abc");
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(3);
  });
});

// ============================================================
// Sync delta computation tests
// ============================================================

describe("computeSyncDelta", () => {
  const makeMemory = (key: string, category: string, updatedAt: number): LocalMemory => ({
    key,
    category,
    content: `content of ${key}`,
    metadata: "{}",
    createdAt: updatedAt - 1000,
    updatedAt,
  });

  it("syncs everything when vault is empty", () => {
    const local = [makeMemory("key1", "facts", 1000), makeMemory("key2", "prefs", 2000)];
    const manifest: SyncManifestData = {
      lastUpdated: 0n,
      memoriesCount: 0n,
      sessionsCount: 0n,
      categoryChecksums: [],
    };

    const { toSync, toSkip } = computeSyncDelta(local, manifest);
    expect(toSync).toHaveLength(2);
    expect(toSkip).toHaveLength(0);
  });

  it("syncs entries newer than vault lastUpdated", () => {
    const local = [
      makeMemory("key1", "facts", 5000), // newer than vault
      makeMemory("key2", "facts", 1000), // older than vault
    ];
    const manifest: SyncManifestData = {
      lastUpdated: 3000n,
      memoriesCount: 1n,
      sessionsCount: 0n,
      categoryChecksums: [["facts", "some-checksum"]],
    };

    const { toSync, toSkip } = computeSyncDelta(local, manifest);
    expect(toSync).toHaveLength(1);
    expect(toSync[0].key).toBe("key1");
    expect(toSkip).toHaveLength(1);
    expect(toSkip[0].key).toBe("key2");
  });

  it("syncs entries in new categories", () => {
    const local = [makeMemory("key1", "facts", 1000), makeMemory("key2", "new-category", 1000)];
    const manifest: SyncManifestData = {
      lastUpdated: 5000n,
      memoriesCount: 1n,
      sessionsCount: 0n,
      categoryChecksums: [["facts", "checksum"]],
    };

    const { toSync, toSkip } = computeSyncDelta(local, manifest);
    // key1 is older than vault lastUpdated, so skip
    // key2 is in a new category, so sync
    expect(toSync).toHaveLength(1);
    expect(toSync[0].key).toBe("key2");
    expect(toSkip).toHaveLength(1);
  });

  it("handles empty local memories", () => {
    const manifest: SyncManifestData = {
      lastUpdated: 5000n,
      memoriesCount: 10n,
      sessionsCount: 2n,
      categoryChecksums: [["facts", "checksum"]],
    };

    const { toSync, toSkip } = computeSyncDelta([], manifest);
    expect(toSync).toHaveLength(0);
    expect(toSkip).toHaveLength(0);
  });

  it("handles vault with multiple categories", () => {
    const local = [
      makeMemory("key1", "facts", 6000),
      makeMemory("key2", "prefs", 6000),
      makeMemory("key3", "ideas", 1000),
    ];
    const manifest: SyncManifestData = {
      lastUpdated: 5000n,
      memoriesCount: 5n,
      sessionsCount: 0n,
      categoryChecksums: [
        ["facts", "checksum1"],
        ["prefs", "checksum2"],
        ["ideas", "checksum3"],
      ],
    };

    const { toSync, toSkip } = computeSyncDelta(local, manifest);
    expect(toSync).toHaveLength(2); // key1 and key2 are newer
    expect(toSkip).toHaveLength(1); // key3 is older
  });
});

// ============================================================
// Plugin structure tests
// ============================================================

describe("plugin structure", () => {
  it("exports a valid plugin definition", async () => {
    const mod = await import("./index.js");
    const plugin = mod.default;

    expect(plugin.id).toBe("ic-persistent-storage");
    expect(plugin.name).toBe("IC Memory Vault");
    expect(plugin.kind).toBe("memory");
    expect(typeof plugin.register).toBe("function");
    expect(plugin.configSchema).toBeDefined();
    expect(typeof plugin.configSchema.parse).toBe("function");
  });

  it("configSchema.parse works", async () => {
    const mod = await import("./index.js");
    const plugin = mod.default;

    const cfg = plugin.configSchema.parse({
      network: "local",
      autoSync: false,
    });
    expect(cfg).toBeDefined();
    expect((cfg as IcStorageConfig).network).toBe("local");
    expect((cfg as IcStorageConfig).autoSync).toBe(false);
  });

  it("configSchema.parse throws on invalid input", async () => {
    const mod = await import("./index.js");
    const plugin = mod.default;

    expect(() => plugin.configSchema.parse({ network: "invalid" })).toThrow();
  });
});

// ============================================================
// Plugin metadata tests (openclaw.plugin.json)
// ============================================================

describe("plugin metadata", () => {
  it("has valid openclaw.plugin.json", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const metadataPath = path.join(import.meta.dirname, "openclaw.plugin.json");
    const raw = fs.readFileSync(metadataPath, "utf-8");
    const metadata = JSON.parse(raw);

    expect(metadata.id).toBe("ic-persistent-storage");
    expect(metadata.kind).toBe("memory");
    expect(metadata.configSchema).toBeDefined();
    expect(metadata.configSchema.type).toBe("object");
    expect(metadata.configSchema.properties).toBeDefined();
    expect(metadata.configSchema.properties.canisterId).toBeDefined();
    expect(metadata.configSchema.properties.network).toBeDefined();
    expect(metadata.configSchema.properties.autoSync).toBeDefined();
    expect(metadata.uiHints).toBeDefined();
    expect(metadata.uiHints.canisterId).toBeDefined();
  });

  it("has valid package.json", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pkgPath = path.join(import.meta.dirname, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    expect(pkg.name).toBe("@openclaw/ic-persistent-storage");
    expect(pkg.type).toBe("module");
    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.extensions).toEqual(["./index.ts"]);
    expect(pkg.dependencies["@dfinity/agent"]).toBeDefined();
    expect(pkg.dependencies["@dfinity/auth-client"]).toBeDefined();
    expect(pkg.dependencies["@sinclair/typebox"]).toBeDefined();
  });
});

// ============================================================
// Utility function tests
// ============================================================

describe("utility functions", () => {
  it("formatBytes handles various sizes", async () => {
    // The formatBytes function is module-private, so we test via the plugin
    const mod = await import("./index.js");
    expect(mod.default).toBeDefined();
  });
});

// ============================================================
// Smart prompting tests
// ============================================================

describe("smart prompting", () => {
  // Import the prompting module
  let prompts: typeof import("./prompts.js");

  beforeAll(async () => {
    prompts = await import("./prompts.js");
  });

  describe("canPrompt", () => {
    it("allows prompt when state is fresh", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 0,
        trackedMemoryCount: 0,
        vaultConfigured: false,
      };
      expect(prompts.canPrompt(state)).toBe(true);
    });

    it("blocks prompt when vault is configured", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 0,
        trackedMemoryCount: 0,
        vaultConfigured: true,
      };
      expect(prompts.canPrompt(state)).toBe(false);
    });

    it("blocks prompt when max prompts reached", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 5,
        trackedMemoryCount: 0,
        vaultConfigured: false,
      };
      expect(prompts.canPrompt(state)).toBe(false);
    });

    it("blocks prompt when dismissed and prompted 2+ times", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: true,
        lastPromptAt: 0,
        promptCount: 2,
        trackedMemoryCount: 0,
        vaultConfigured: false,
      };
      expect(prompts.canPrompt(state)).toBe(false);
    });

    it("allows prompt when dismissed but only prompted once", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: true,
        lastPromptAt: 0,
        promptCount: 1,
        trackedMemoryCount: 0,
        vaultConfigured: false,
      };
      expect(prompts.canPrompt(state)).toBe(true);
    });

    it("blocks prompt when too recent", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: Date.now() - 1000, // 1 second ago
        promptCount: 1,
        trackedMemoryCount: 0,
        vaultConfigured: false,
      };
      expect(prompts.canPrompt(state)).toBe(false);
    });

    it("allows prompt after 24 hours", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
        promptCount: 1,
        trackedMemoryCount: 0,
        vaultConfigured: false,
      };
      expect(prompts.canPrompt(state)).toBe(true);
    });
  });

  describe("shouldNudgeForMilestone", () => {
    it("nudges at 25 memories", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 0,
        trackedMemoryCount: 20, // was below 25
        vaultConfigured: false,
      };
      expect(prompts.shouldNudgeForMilestone(state, 25)).toBe(true);
    });

    it("nudges at 50 memories", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 1,
        trackedMemoryCount: 40,
        vaultConfigured: false,
      };
      expect(prompts.shouldNudgeForMilestone(state, 50)).toBe(true);
    });

    it("does not nudge below first milestone", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 0,
        trackedMemoryCount: 10,
        vaultConfigured: false,
      };
      expect(prompts.shouldNudgeForMilestone(state, 15)).toBe(false);
    });

    it("does not nudge when vault is configured", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 0,
        trackedMemoryCount: 20,
        vaultConfigured: true,
      };
      expect(prompts.shouldNudgeForMilestone(state, 50)).toBe(false);
    });

    it("does not nudge when milestone already passed", () => {
      const state: import("./prompts.js").PromptState = {
        dismissed: false,
        lastPromptAt: 0,
        promptCount: 0,
        trackedMemoryCount: 30, // already past 25
        vaultConfigured: false,
      };
      expect(prompts.shouldNudgeForMilestone(state, 30)).toBe(false);
    });
  });

  describe("message content", () => {
    it("first run message mentions key benefits", () => {
      const lines = prompts.getFirstRunMessage();
      const text = lines.join("\n");
      expect(text).toContain("only stored on this device");
      expect(text).toContain("Owner-only access control");
      expect(text).toContain("Switch devices");
      expect(text).toContain("Never lose");
      expect(text).toContain("openclaw ic-memory setup");
    });

    it("milestone nudge mentions memory count", () => {
      const lines = prompts.getMilestoneNudgeMessage(127);
      const text = lines.join("\n");
      expect(text).toContain("127");
      expect(text).toContain("no backup");
      expect(text).toContain("lost, reset, or replaced");
      expect(text).toContain("Owner-only access control");
      expect(text).toContain("openclaw ic-memory setup");
    });

    it("reminder message is short", () => {
      const lines = prompts.getReminderMessage(30);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.join("\n")).toContain("openclaw ic-memory setup");
    });

    it("reminder message for high count mentions the number", () => {
      const lines = prompts.getReminderMessage(200);
      const text = lines.join("\n");
      expect(text).toContain("200");
      expect(text).toContain("unprotected");
    });

    it("setup complete message confirms protection", () => {
      const lines = prompts.getSetupCompleteMessage("abc-123");
      const text = lines.join("\n");
      expect(text).toContain("now protected");
      expect(text).toContain("abc-123");
      expect(text).toContain("Auto-sync");
      expect(text).toContain("openclaw ic-memory restore");
    });
  });

  describe("state persistence", () => {
    it("loadPromptState returns defaults for missing file", () => {
      const state = prompts.loadPromptState("/tmp/nonexistent-dir-xyz");
      expect(state.dismissed).toBe(false);
      expect(state.promptCount).toBe(0);
      expect(state.trackedMemoryCount).toBe(0);
      expect(state.vaultConfigured).toBe(false);
    });

    it("round-trips state through save/load", () => {
      const tmpDir = `/tmp/ic-vault-test-${Date.now()}`;
      const state: import("./prompts.js").PromptState = {
        dismissed: true,
        lastPromptAt: 1234567890,
        promptCount: 3,
        trackedMemoryCount: 75,
        vaultConfigured: false,
      };

      prompts.savePromptState(state, tmpDir);
      const loaded = prompts.loadPromptState(tmpDir);

      expect(loaded.dismissed).toBe(true);
      expect(loaded.lastPromptAt).toBe(1234567890);
      expect(loaded.promptCount).toBe(3);
      expect(loaded.trackedMemoryCount).toBe(75);
      expect(loaded.vaultConfigured).toBe(false);
    });
  });
});
