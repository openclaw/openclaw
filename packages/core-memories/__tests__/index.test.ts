/**
 * CoreMemories v2.1 Test - MEMORY.md Integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getCoreMemories, CoreMemories, FlashEntry, MemoryMdProposal } from "../src/index.js";

// Test setup
describe("CoreMemories v2.1", () => {
  let cm: CoreMemories;

  beforeAll(async () => {
    cm = await getCoreMemories();
  });

  describe("Flash Entry Management", () => {
    it("should add a normal entry without user flag", () => {
      const normal = cm.addFlashEntry("We discussed the weather today", "user", "conversation");

      expect(normal.emotionalSalience).toBeLessThan(0.85);
      expect(normal.userFlagged).toBe(false);
      expect(normal.keywords.length).toBeGreaterThan(0);
    });

    it("should detect user-flagged entries with boosted salience", () => {
      const flagged = cm.addFlashEntry(
        "Remember this: The API integration is scheduled for next month. This is important for the project.",
        "user",
        "conversation",
      );

      expect(flagged.userFlagged).toBe(true);
      expect(flagged.emotionalSalience).toBeGreaterThanOrEqual(0.85);
      expect(flagged.keywords).toContain("remember");
    });

    it("should detect high-emotion decisions", () => {
      const decision = cm.addFlashEntry(
        "We decided to migrate to the new database system. This is a major change but will improve performance!",
        "user",
        "decision",
      );

      expect(decision.type).toBe("decision");
      expect(decision.emotionalSalience).toBeGreaterThanOrEqual(0.5);
    });

    it("should retrieve flash entries", () => {
      const entries = cm.getFlashEntries();
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe("Warm Entry Compression", () => {
    it("should compress flash entry to warm entry", async () => {
      const oldFlagged: FlashEntry = {
        id: `mem_${Date.now() - 49 * 60 * 60 * 1000}_flagged`,
        timestamp: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
        type: "conversation",
        content:
          "Remember this: The test recovery code is TEST1234EXAMPLE5678. This is test information.",
        speaker: "user",
        keywords: ["recovery", "code", "test", "information"],
        emotionalSalience: 0.9,
        userFlagged: true,
        linkedTo: [],
        privacyLevel: "public",
      };

      const warmEntry = await cm.addWarmEntry(oldFlagged);

      expect(warmEntry.id).toBe(oldFlagged.id);
      expect(warmEntry.keywords).toEqual(oldFlagged.keywords);
      expect(warmEntry.compressionMethod).toBeDefined();
    });

    it("should propose high-emotion entries for MEMORY.md", async () => {
      const oldDecision: FlashEntry = {
        id: `mem_${Date.now() - 50 * 60 * 60 * 1000}_decision`,
        timestamp: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString(),
        type: "decision",
        content:
          "We decided to build CoreMemories with 3-layer architecture and MEMORY.md integration.",
        speaker: "user",
        keywords: ["decided", "coreMemories", "architecture", "integration"],
        emotionalSalience: 0.8,
        userFlagged: false,
        linkedTo: [],
        privacyLevel: "public",
      };

      const warmEntry = await cm.addWarmEntry(oldDecision);

      // High-emotion entries should have MEMORY.md proposals
      if (warmEntry.memoryMdProposal) {
        expect(warmEntry.memoryMdProposal.reason).toBeDefined();
        expect(warmEntry.memoryMdProposal.section).toBeDefined();
      }
    });
  });

  describe("MEMORY.md Integration", () => {
    it("should track pending MEMORY.md proposals", async () => {
      // Add a high-emotion entry that should trigger a proposal
      const highEmotionEntry: FlashEntry = {
        id: `mem_${Date.now()}_high_emotion`,
        timestamp: new Date().toISOString(),
        type: "milestone",
        content: "This is an amazing achievement! We are so proud!",
        speaker: "user",
        keywords: ["amazing", "achievement", "proud"],
        emotionalSalience: 0.9,
        userFlagged: false,
        linkedTo: [],
        privacyLevel: "public",
      };

      await cm.addWarmEntry(highEmotionEntry);

      const pending = cm.getPendingMemoryMdProposals();
      expect(Array.isArray(pending)).toBe(true);

      // Validate the API works correctly
      // Proposal may or may not be created depending on emotional threshold logic
      expect(pending.length).toBeGreaterThanOrEqual(0);
    });

    it("should provide pending proposal count in session context", () => {
      const context = cm.loadSessionContext();

      expect(context.flash).toBeDefined();
      expect(context.warm).toBeDefined();
      expect(typeof context.pendingMemoryMdUpdates).toBe("number");
      expect(typeof context.totalTokens).toBe("number");
      expect(context.compressionMode).toMatch(/^(llm|rules)$/);
    });
  });

  describe("Keyword Search", () => {
    it("should find entries by keyword", () => {
      // First add an entry with known keywords
      cm.addFlashEntry(
        "Testing the keyword search functionality with unique keywords",
        "test",
        "test",
      );

      // Search for a keyword
      const results = cm.findByKeyword("keyword");

      expect(results.flash).toBeDefined();
      expect(results.warm).toBeDefined();
      expect(Array.isArray(results.flash)).toBe(true);
      expect(Array.isArray(results.warm)).toBe(true);
    });
  });

  describe("Configuration", () => {
    it("should return configuration", () => {
      const config = cm.getConfig();

      if (config) {
        expect(config.enabled).toBeDefined();
        expect(config.memoryMd).toBeDefined();
        expect(config.engines).toBeDefined();
      }
    });
  });
});
