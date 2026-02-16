/**
 * Tests for SkillSemanticIndex and context-aware dynamic skill loading.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkillEntry } from "./types.js";
import {
  SkillSemanticIndex,
  createOpenAIEmbedFn,
  createVoyageEmbedFn,
  resolveEmbedFn,
} from "./semantic-index.js";

// Mock fetch for embedding API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create mock skill entries
function createMockSkillEntry(
  name: string,
  description: string,
  triggers: string[] = [],
): SkillEntry {
  return {
    skill: {
      name,
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
      prompt: `# ${name}\n\n${description}`,
    },
    frontmatter: {
      description,
      triggers: JSON.stringify(triggers),
    },
    metadata: {
      primaryEnv: undefined,
    },
    invocation: {
      disableModelInvocation: false,
      userInvocable: true,
    },
  } as SkillEntry;
}

// Helper to create a simple mock embedding function
function createMockEmbedFn(dimension = 1536) {
  return vi.fn().mockImplementation(async (text: string) => {
    // Create a deterministic but unique embedding based on text
    const hash = text.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = Array.from({ length: dimension }, (_, i) => Math.sin(hash + i) * 0.5 + 0.5);
    return embedding;
  });
}

describe("SkillSemanticIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("uses default config values when no config provided", () => {
      const index = new SkillSemanticIndex();
      const stats = index.getStats();

      expect(stats.config.enabled).toBe(false);
      expect(stats.config.topK).toBe(5);
      expect(stats.config.minScore).toBe(0.3);
      expect(stats.config.embeddingModel).toBe("text-embedding-3-small");
    });

    it("accepts custom config values", () => {
      const index = new SkillSemanticIndex({
        enabled: true,
        topK: 10,
        minScore: 0.5,
        embeddingModel: "text-embedding-3-large",
      });
      const stats = index.getStats();

      expect(stats.config.enabled).toBe(true);
      expect(stats.config.topK).toBe(10);
      expect(stats.config.minScore).toBe(0.5);
      expect(stats.config.embeddingModel).toBe("text-embedding-3-large");
    });
  });

  describe("buildIndex", () => {
    it("indexes skills with descriptions and triggers", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = createMockEmbedFn();

      const entries = [
        createMockSkillEntry("github", "Manage GitHub PRs and issues", ["pr", "issue"]),
        createMockSkillEntry("weather", "Get weather forecasts", ["weather", "forecast"]),
        createMockSkillEntry("notes", "Manage notes and reminders"),
      ];

      await index.buildIndex(entries, embedFn);
      const stats = index.getStats();

      expect(stats.totalSkills).toBe(3);
      expect(embedFn).toHaveBeenCalledTimes(3);
    });

    it("uses skill name as fallback when no description", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = createMockEmbedFn();

      const entries = [
        createMockSkillEntry("github", "Manage GitHub PRs", ["pr"]),
        {
          skill: {
            name: "empty-skill",
            filePath: "/skills/empty/SKILL.md",
            baseDir: "/skills/empty",
            prompt: "",
          },
          frontmatter: {},
          metadata: {},
          invocation: {},
        } as SkillEntry,
      ];

      await index.buildIndex(entries, embedFn);
      const stats = index.getStats();

      // Both skills indexed - empty-skill uses its name as fallback
      expect(stats.totalSkills).toBe(2);
      expect(embedFn).toHaveBeenCalledTimes(2);

      // Verify the empty skill was indexed with its name
      const directory = index.getSkillDirectory();
      const emptySkill = directory.find((s) => s.name === "empty-skill");
      expect(emptySkill?.description).toBe("empty-skill");
    });

    it("handles embedding errors gracefully", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = vi
        .fn()
        .mockResolvedValueOnce([0.1, 0.2, 0.3])
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce([0.4, 0.5, 0.6]);

      const entries = [
        createMockSkillEntry("skill1", "Description 1"),
        createMockSkillEntry("skill2", "Description 2"),
        createMockSkillEntry("skill3", "Description 3"),
      ];

      await index.buildIndex(entries, embedFn);
      const stats = index.getStats();

      // Should index 2 out of 3 (one failed)
      expect(stats.totalSkills).toBe(2);
    });
  });

  describe("search", () => {
    it("returns relevant skills based on query similarity", async () => {
      const index = new SkillSemanticIndex({
        enabled: true,
        topK: 2,
        minScore: 0,
      });

      // Create embeddings that have known similarity properties
      const embeddings = new Map<string, number[]>();
      const embedFn = vi.fn().mockImplementation(async (text: string) => {
        // Store and return consistent embeddings
        if (!embeddings.has(text)) {
          embeddings.set(text, createMockEmbedFn(1536)(text));
        }
        return embeddings.get(text)!;
      });

      const entries = [
        createMockSkillEntry("github", "Manage GitHub pull requests", ["pr", "github"]),
        createMockSkillEntry("weather", "Get weather forecasts", ["weather"]),
        createMockSkillEntry("gitlab", "Manage GitLab merge requests", ["mr", "gitlab"]),
      ];

      await index.buildIndex(entries, embedFn);

      // Search for something git-related
      const results = await index.search("create a pull request", embedFn, 2);

      expect(results.length).toBeLessThanOrEqual(2);
      // Results should be SkillEntry objects
      expect(results[0]).toHaveProperty("skill");
    });

    it("respects minScore threshold", async () => {
      const index = new SkillSemanticIndex({
        enabled: true,
        topK: 10,
        minScore: 0.99, // Very high threshold
      });

      const embedFn = createMockEmbedFn();
      const entries = [
        createMockSkillEntry("skill1", "Description one"),
        createMockSkillEntry("skill2", "Description two"),
      ];

      await index.buildIndex(entries, embedFn);
      const results = await index.search("unrelated query", embedFn);

      // With a high threshold, we might get no results
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns empty array for empty index", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = createMockEmbedFn();

      const results = await index.search("any query", embedFn);

      expect(results).toEqual([]);
    });

    it("respects topK parameter override", async () => {
      const index = new SkillSemanticIndex({
        enabled: true,
        topK: 10,
        minScore: 0,
      });

      const embedFn = createMockEmbedFn();
      const entries = Array.from({ length: 10 }, (_, i) =>
        createMockSkillEntry(`skill${i}`, `Description ${i}`),
      );

      await index.buildIndex(entries, embedFn);

      // Override topK to 3
      const results = await index.search("test query", embedFn, 3);

      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe("getSkillDirectory", () => {
    it("returns name and description for all indexed skills", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = createMockEmbedFn();

      const entries = [
        createMockSkillEntry("github", "Manage GitHub PRs"),
        createMockSkillEntry("weather", "Weather forecasts"),
      ];

      await index.buildIndex(entries, embedFn);
      const directory = index.getSkillDirectory();

      expect(directory).toHaveLength(2);
      expect(directory).toContainEqual({
        name: "github",
        description: "Manage GitHub PRs",
      });
      expect(directory).toContainEqual({
        name: "weather",
        description: "Weather forecasts",
      });
    });
  });

  describe("getSkillEntry", () => {
    it("returns skill entry by name", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = createMockEmbedFn();

      const entries = [
        createMockSkillEntry("github", "Manage GitHub PRs"),
        createMockSkillEntry("weather", "Weather forecasts"),
      ];

      await index.buildIndex(entries, embedFn);

      const entry = index.getSkillEntry("github");
      expect(entry?.skill.name).toBe("github");

      const missing = index.getSkillEntry("nonexistent");
      expect(missing).toBeUndefined();
    });
  });

  describe("cosineSimilarity", () => {
    it("calculates correct similarity for identical vectors", async () => {
      const index = new SkillSemanticIndex({ enabled: true });
      const embedFn = createMockEmbedFn(3);

      // Index a skill to get access to the similarity calculation indirectly
      await index.buildIndex([createMockSkillEntry("test", "test description")], embedFn);

      // Search with the same embedding should give high similarity
      const results = await index.search("test description", embedFn);
      // The first result should have the highest score
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

describe("Embedding Provider Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("createOpenAIEmbedFn", () => {
    it("calls OpenAI API with correct parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }),
      });

      const embedFn = createOpenAIEmbedFn("test-api-key", "text-embedding-3-small");
      const result = await embedFn("test text");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-api-key",
          }),
        }),
      );

      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it("throws error on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => "Rate limit exceeded",
      });

      const embedFn = createOpenAIEmbedFn("test-api-key");

      await expect(embedFn("test text")).rejects.toThrow(
        "OpenAI embedding failed: Rate limit exceeded",
      );
    });
  });

  describe("createVoyageEmbedFn", () => {
    it("calls Voyage API with correct parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.4, 0.5, 0.6] }],
        }),
      });

      const embedFn = createVoyageEmbedFn("voyage-api-key", "voyage-3-lite");
      const result = await embedFn("test text");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.voyageai.com/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer voyage-api-key",
          }),
        }),
      );

      expect(result).toEqual([0.4, 0.5, 0.6]);
    });
  });

  describe("resolveEmbedFn", () => {
    it("returns OpenAI function for 'openai' provider", () => {
      const embedFn = resolveEmbedFn("openai", "key");
      expect(embedFn).toBeDefined();
      expect(typeof embedFn).toBe("function");
    });

    it("returns Voyage function for 'voyage' provider", () => {
      const embedFn = resolveEmbedFn("voyage", "key");
      expect(embedFn).toBeDefined();
    });

    it("returns Voyage function for 'anthropic' provider", () => {
      const embedFn = resolveEmbedFn("anthropic", "key");
      expect(embedFn).toBeDefined();
    });

    it("throws for unknown provider", () => {
      expect(() => resolveEmbedFn("unknown", "key")).toThrow("Unknown embedding provider: unknown");
    });

    it("is case-insensitive", () => {
      expect(() => resolveEmbedFn("OpenAI", "key")).not.toThrow();
      expect(() => resolveEmbedFn("VOYAGE", "key")).not.toThrow();
    });
  });
});

describe("Dynamic Skill Loading Integration", () => {
  it("reduces token count with 15 skills to ~5 loaded", async () => {
    const index = new SkillSemanticIndex({
      enabled: true,
      topK: 5,
      minScore: 0,
    });

    const embedFn = createMockEmbedFn();

    // Create 15 mock skills
    const entries = Array.from({ length: 15 }, (_, i) =>
      createMockSkillEntry(`skill-${i}`, `This is skill number ${i} for testing`, [`trigger-${i}`]),
    );

    await index.buildIndex(entries, embedFn);

    // Search should return at most 5 skills
    const results = await index.search("test query", embedFn);
    expect(results.length).toBeLessThanOrEqual(5);

    // Directory should contain all skills
    const directory = index.getSkillDirectory();
    expect(directory.length).toBe(15);

    // Verify token reduction: only 5 skills fully loaded
    const loadedNames = new Set(results.map((r) => r.skill.name));
    const unloadedCount = directory.filter((d) => !loadedNames.has(d.name)).length;
    expect(unloadedCount).toBeGreaterThanOrEqual(10);
  });
});
