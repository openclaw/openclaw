import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gliner npm package so we don't need the actual 1.4GB model
vi.mock("gliner", () => {
  class MockGliner {
    private config: any;

    constructor(config: any) {
      this.config = config;
    }

    async initialize(): Promise<void> {
      // No-op in mock
    }

    async inference(
      text: string,
      labels: string[],
      options: { threshold: number },
    ): Promise<Array<{ text: string; label: string; score: number; start: number; end: number }>> {
      const results: Array<{ text: string; label: string; score: number; start: number; end: number }> = [];

      // Simulate entity detection for "John Smith"
      const johnIndex = text.indexOf("John Smith");
      if (johnIndex !== -1 && labels.includes("person")) {
        results.push({
          text: "John Smith",
          label: "person",
          score: 0.95,
          start: johnIndex,
          end: johnIndex + "John Smith".length,
        });
      }

      // Simulate entity detection for "Acme Corp"
      const acmeIndex = text.indexOf("Acme Corp");
      if (acmeIndex !== -1 && labels.includes("organization")) {
        results.push({
          text: "Acme Corp",
          label: "organization",
          score: 0.88,
          start: acmeIndex,
          end: acmeIndex + "Acme Corp".length,
        });
      }

      // Simulate entity detection for "New York"
      const nyIndex = text.indexOf("New York");
      if (nyIndex !== -1 && labels.includes("location")) {
        results.push({
          text: "New York",
          label: "location",
          score: 0.91,
          start: nyIndex,
          end: nyIndex + "New York".length,
        });
      }

      return results;
    }
  }

  return { Gliner: MockGliner };
});

import { GlinerEngine } from "../src/engines/gliner.js";

describe("GlinerEngine", () => {
  let engine: GlinerEngine;

  beforeEach(async () => {
    engine = new GlinerEngine("onnx-community/gliner_small-v2.5", 0.5);
    await engine.initialize();
  });

  it("detects person entities with canonical PERSON label", async () => {
    const entities = await engine.scan("My name is John Smith and I live here.");

    expect(entities).toHaveLength(1);
    expect(entities[0].text).toBe("John Smith");
    expect(entities[0].label).toBe("PERSON");
  });

  it("detects organization entities with canonical ORGANIZATION label", async () => {
    const entities = await engine.scan("I work at Acme Corp downtown.");

    expect(entities).toHaveLength(1);
    expect(entities[0].text).toBe("Acme Corp");
    expect(entities[0].label).toBe("ORGANIZATION");
  });

  it("detects multiple entity types in the same text", async () => {
    const entities = await engine.scan(
      "John Smith works at Acme Corp in New York.",
    );

    expect(entities).toHaveLength(3);

    const labels = entities.map((e) => e.label);
    expect(labels).toContain("PERSON");
    expect(labels).toContain("ORGANIZATION");
    expect(labels).toContain("LOCATION");
  });

  it("returns empty array for text with no entities", async () => {
    const entities = await engine.scan("Hello world, this is a test.");

    expect(entities).toEqual([]);
  });

  it("returns empty array for empty string input", async () => {
    const entities = await engine.scan("");

    expect(entities).toEqual([]);
  });

  it("allows setting custom labels without crashing", async () => {
    expect(() => engine.setCustomLabels(["product", "event"])).not.toThrow();

    // Scan still works after setting custom labels
    const entities = await engine.scan("John Smith attended the event.");
    expect(entities).toHaveLength(1);
    expect(entities[0].label).toBe("PERSON");
  });

  it("applies canonical type mapping (lowercase person -> PERSON)", async () => {
    // The mock returns lowercase "person" as label; canonicalType should map it to "PERSON"
    const entities = await engine.scan("John Smith is here.");

    expect(entities[0].label).toBe("PERSON");
    // Verify it's not lowercase
    expect(entities[0].label).not.toBe("person");
  });

  it("sets source to gliner for all detected entities", async () => {
    const entities = await engine.scan(
      "John Smith works at Acme Corp in New York.",
    );

    for (const entity of entities) {
      expect(entity.source).toBe("gliner");
    }
  });

  it("confidence comes from model score", async () => {
    const entities = await engine.scan(
      "John Smith works at Acme Corp in New York.",
    );

    const person = entities.find((e) => e.label === "PERSON");
    const org = entities.find((e) => e.label === "ORGANIZATION");
    const loc = entities.find((e) => e.label === "LOCATION");

    // These match the scores set in our mock
    expect(person?.confidence).toBe(0.95);
    expect(org?.confidence).toBe(0.88);
    expect(loc?.confidence).toBe(0.91);
  });

  it("throws if scan is called before initialize", async () => {
    const uninitializedEngine = new GlinerEngine("some-model", 0.5);

    await expect(uninitializedEngine.scan("test")).rejects.toThrow(
      "GLiNER engine not initialized. Call initialize() first.",
    );
  });

  it("reports isInitialized correctly", async () => {
    const freshEngine = new GlinerEngine("some-model", 0.5);
    expect(freshEngine.isInitialized).toBe(false);

    await freshEngine.initialize();
    expect(freshEngine.isInitialized).toBe(true);
  });

  it("includes correct start and end offsets", async () => {
    const text = "Contact John Smith for details.";
    const entities = await engine.scan(text);

    expect(entities).toHaveLength(1);
    expect(entities[0].start).toBe(8); // "Contact " is 8 chars
    expect(entities[0].end).toBe(18); // 8 + "John Smith".length = 18
  });
});
