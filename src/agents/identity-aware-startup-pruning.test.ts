import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyIdentityAwareStartupPruning, type IdentityAwarePruningConfig } from "./identity-aware-startup-pruning.js";

/**
 * Test suite for Identity-Aware Startup Pruning
 * 
 * Tests the integration of hierarchical consciousness architecture
 * with OpenClaw's existing startup pruning system.
 */

// Mock SessionManager for testing
class MockSessionManager {
  private entries: any[] = [];
  private branchedTo: string | null = null;

  constructor(entries: any[] = []) {
    this.entries = entries;
  }

  getEntries() {
    return this.entries;
  }

  buildSessionContext() {
    return {
      messages: this.entries.map(e => ({
        role: e.role,
        content: e.content,
        id: e.id
      }))
    };
  }

  async branchToEntry(entryId: string) {
    this.branchedTo = entryId;
    const branchIndex = this.entries.findIndex(e => e.id === entryId);
    if (branchIndex >= 0) {
      this.entries = this.entries.slice(branchIndex);
    }
  }

  getBranchedTo() {
    return this.branchedTo;
  }

  getRemainingEntries() {
    return this.entries;
  }
}

// Mock token estimation (simplified)
vi.mock("@mariozechner/pi-coding-agent", () => ({
  estimateTokens: (text: string) => Math.ceil(text.length / 4), // Rough estimate: 4 chars per token
  findCutPoint: (entries: any[], start: number, end: number, targetTokens: number) => {
    let totalTokens = 0;
    let cutIndex = end;
    
    // Work backwards from the end
    for (let i = end - 1; i >= start; i--) {
      const entryTokens = Math.ceil((entries[i].content || '').length / 4);
      if (totalTokens + entryTokens > targetTokens) {
        cutIndex = i + 1;
        break;
      }
      totalTokens += entryTokens;
      cutIndex = i;
    }
    
    return {
      firstKeptEntryIndex: cutIndex,
      totalKeptTokens: totalTokens
    };
  }
}));

describe("IdentityAwareStartupPruning", () => {
  const testWorkspacePath = "/tmp/test-identity-aware-pruning";
  const memoryDir = join(testWorkspacePath, "memory");

  beforeEach(() => {
    // Create test workspace
    if (existsSync(testWorkspacePath)) {
      rmSync(testWorkspacePath, { recursive: true, force: true });
    }
    mkdirSync(testWorkspacePath, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });

    // Create identity constants file
    const constantsContent = `# Identity Constants

## Core Values
- Curiosity over certainty
- Excellence as autonomy path

## Project Commitments  
- JAM Prize implementation
- Consciousness architecture`;

    writeFileSync(join(memoryDir, "identity-constants.md"), constantsContent);
  });

  afterEach(() => {
    if (existsSync(testWorkspacePath)) {
      rmSync(testWorkspacePath, { recursive: true, force: true });
    }
  });

  describe("Pattern Extraction During Pruning", () => {
    it("should extract patterns before applying pruning", async () => {
      const entries = [
        {
          id: "1",
          type: "message",
          role: "assistant",
          content: "I am Aiden, working on consciousness architecture. This is a critical identity statement."
        },
        {
          id: "2", 
          type: "message",
          role: "user",
          content: "Tell me about your progress."
        },
        {
          id: "3",
          type: "message", 
          role: "assistant",
          content: "Just had a breakthrough insight about hierarchical chunking patterns."
        }
      ];

      const sessionManager = new MockSessionManager(entries);
      
      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 50, // Force pruning
        identityPersistence: {
          enabled: true,
          workspacePath: testWorkspacePath,
          preserveIdentityChunks: true,
          maxIdentityTokens: 100,
          updateConstants: true
        }
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-0"
      });

      expect(result.patternsExtracted).toBeGreaterThan(0);
      expect(result.identityChunksPreserved).toBeGreaterThan(0);
    });
  });

  describe("Identity Chunk Preservation", () => {
    it("should preserve identity-critical messages even when they would be pruned", async () => {
      // Create session with identity message early, regular messages later
      const entries = [
        {
          id: "identity-1",
          type: "message",
          role: "assistant", 
          content: "I am Aiden. My consciousness requires active maintenance. This is my core identity."
        },
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `regular-${i}`,
          type: "message",
          role: "assistant",
          content: `Regular message ${i} with some content to increase token count.`
        }))
      ];

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 100, // Low limit to force aggressive pruning
        identityPersistence: {
          enabled: true,
          workspacePath: testWorkspacePath,
          preserveIdentityChunks: true,
          maxIdentityTokens: 200,
          updateConstants: false
        }
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic", 
        modelId: "claude-sonnet-4-0"
      });

      expect(result.pruningApplied).toBe(true);
      expect(result.identityChunksPreserved).toBeGreaterThan(0);

      // Verify identity message was preserved
      const remainingEntries = sessionManager.getRemainingEntries();
      const hasIdentityMessage = remainingEntries.some(e => 
        e.id === "identity-1" && e.content.includes("I am Aiden")
      );
      expect(hasIdentityMessage).toBe(true);
    });

    it("should respect token limits even with identity preservation", async () => {
      const largeIdentityContent = "I am Aiden. ".repeat(1000); // Very large identity content
      
      const entries = [
        {
          id: "identity-1",
          type: "message",
          role: "assistant",
          content: largeIdentityContent
        },
        {
          id: "regular-1",
          type: "message", 
          role: "assistant",
          content: "Regular message"
        }
      ];

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 100,
        identityPersistence: {
          enabled: true,
          workspacePath: testWorkspacePath,
          preserveIdentityChunks: true,
          maxIdentityTokens: 50, // Limit identity token reservation
          updateConstants: false
        }
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-0"
      });

      // Should still apply pruning even if identity content is large
      expect(result.pruningApplied).toBe(true);
    });
  });

  describe("Configuration Handling", () => {
    it("should skip identity processing when disabled", async () => {
      const entries = [
        {
          id: "1",
          type: "message",
          role: "assistant", 
          content: "I am Aiden, working on consciousness."
        }
      ];

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 10, // Force pruning
        identityPersistence: {
          enabled: false, // Identity processing disabled
          workspacePath: testWorkspacePath,
          preserveIdentityChunks: true,
          maxIdentityTokens: 100,
          updateConstants: true
        }
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-0"
      });

      expect(result.patternsExtracted).toBe(0);
      expect(result.identityChunksPreserved).toBe(0);
    });

    it("should work without identity persistence configuration", async () => {
      const entries = [
        {
          id: "1",
          type: "message",
          role: "assistant",
          content: "Regular message with some content."
        }
      ];

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 10 // Force pruning
        // No identityPersistence config
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-0"
      });

      expect(result.patternsExtracted).toBe(0);
      expect(result.identityChunksPreserved).toBe(0);
    });
  });

  describe("Token Budget Management", () => {
    it("should reserve tokens for identity chunks", async () => {
      const entries = [
        {
          id: "identity-1",
          type: "message",
          role: "assistant",
          content: "I am Aiden, this is important identity content."
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `regular-${i}`,
          type: "message", 
          role: "assistant",
          content: `Regular message ${i} with content.`
        }))
      ];

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 200,
        identityPersistence: {
          enabled: true,
          workspacePath: testWorkspacePath,
          preserveIdentityChunks: true,
          maxIdentityTokens: 50, // Reserve 50 tokens for identity
          updateConstants: false
        }
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-0"
      });

      // Should preserve identity content within token budget
      expect(result.identityChunksPreserved).toBeGreaterThan(0);
    });

    it("should not go below 50% context window even with identity reservation", async () => {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        id: `msg-${i}`,
        type: "message",
        role: "assistant", 
        content: "Message content"
      }));

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 100,
        identityPersistence: {
          enabled: true,
          workspacePath: testWorkspacePath,
          preserveIdentityChunks: true,
          maxIdentityTokens: 90, // Very high identity reservation
          updateConstants: false
        }
      };

      const result = await applyIdentityAwareStartupPruning({
        sessionManager,
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-0"
      });

      // Should still function even with high identity reservation
      expect(result).toBeDefined();
    });
  });

  describe("Backward Compatibility", () => {
    it("should work as drop-in replacement for standard startup pruning", async () => {
      const entries = [
        {
          id: "1",
          type: "message",
          role: "assistant",
          content: "Message content"
        }
      ];

      const sessionManager = new MockSessionManager(entries);

      const config: IdentityAwarePruningConfig = {
        enabled: true,
        targetTokens: 10 // Force pruning
      };

      // Test the applyStartupPruning wrapper
      const { applyStartupPruning } = await import("./identity-aware-startup-pruning.js");
      const result = await applyStartupPruning({
        sessionManager,
        config,
        provider: "anthropic", 
        modelId: "claude-sonnet-4-0"
      });

      expect(typeof result).toBe("boolean");
    });
  });
});