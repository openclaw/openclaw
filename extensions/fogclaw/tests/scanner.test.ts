import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the gliner npm package so we don't need the actual model
vi.mock("gliner", () => {
  return {
    Gliner: class MockGliner {
      async initialize() {}
      async inference(
        text: string,
        labels: string[],
        _opts: { threshold: number },
      ) {
        const results: any[] = [];

        // Simulate person detection for "John Smith"
        if (text.includes("John Smith")) {
          const idx = text.indexOf("John Smith");
          results.push({
            text: "John Smith",
            label: "person",
            score: 0.95,
            start: idx,
            end: idx + 10,
          });
        }

        // Simulate organization detection for "Acme Corp"
        if (text.includes("Acme Corp")) {
          const idx = text.indexOf("Acme Corp");
          results.push({
            text: "Acme Corp",
            label: "organization",
            score: 0.88,
            start: idx,
            end: idx + 9,
          });
        }

        // Only return results whose labels are requested
        return results.filter((r) => labels.includes(r.label));
      }
    },
  };
});

import { Scanner } from "../src/scanner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { FogClawConfig } from "../src/types.js";

function makeConfig(overrides: Partial<FogClawConfig> = {}): FogClawConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("Scanner", () => {
  let scanner: Scanner;

  beforeEach(async () => {
    scanner = new Scanner(makeConfig());
    await scanner.initialize();
  });

  it("detects regex entities (email) without needing GLiNER", async () => {
    // Even without initialize, regex should work
    const regexOnly = new Scanner(makeConfig());
    // Deliberately NOT calling initialize — GLiNER unavailable

    const result = await regexOnly.scan("Contact us at test@example.com please.");

    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const email = result.entities.find((e) => e.label === "EMAIL");
    expect(email).toBeDefined();
    expect(email!.text).toBe("test@example.com");
    expect(email!.source).toBe("regex");
  });

  it("detects GLiNER entities (person names)", async () => {
    const result = await scanner.scan("My name is John Smith.");

    const person = result.entities.find((e) => e.label === "PERSON");
    expect(person).toBeDefined();
    expect(person!.text).toBe("John Smith");
    expect(person!.source).toBe("gliner");
    expect(person!.confidence).toBe(0.95);
  });

  it("merges results from both engines (email + person in same text)", async () => {
    const result = await scanner.scan(
      "John Smith can be reached at john@example.com for details.",
    );

    const person = result.entities.find((e) => e.label === "PERSON");
    const email = result.entities.find((e) => e.label === "EMAIL");

    expect(person).toBeDefined();
    expect(email).toBeDefined();
    expect(person!.source).toBe("gliner");
    expect(email!.source).toBe("regex");
  });

  it("deduplicates overlapping spans keeping higher confidence", async () => {
    // Scan text that might produce overlapping entities
    // The dedup logic should keep higher confidence when spans overlap
    const result = await scanner.scan("Contact John Smith today.");

    // We shouldn't have duplicate entities for the same span
    const starts = result.entities.map((e) => e.start);
    const uniqueStarts = [...new Set(starts)];
    // If there were overlapping entities, dedup should have resolved them
    expect(starts.length).toBe(uniqueStarts.length);
  });

  it("returns original text in result", async () => {
    const text = "Hello John Smith, your email is test@example.com.";
    const result = await scanner.scan(text);

    expect(result.text).toBe(text);
  });

  it("accepts extra labels at scan time", async () => {
    // The mock only returns results for labels that are in the labels array
    // Extra labels get passed through to GLiNER
    const result = await scanner.scan(
      "John Smith works at Acme Corp.",
      ["organization"],
    );

    // Person is always in default labels, organization should be detected too
    const person = result.entities.find((e) => e.label === "PERSON");
    const org = result.entities.find((e) => e.label === "ORGANIZATION");

    expect(person).toBeDefined();
    expect(org).toBeDefined();
  });

  it("falls back to regex-only when GLiNER is not initialized", async () => {
    const fallbackScanner = new Scanner(makeConfig());
    // Do NOT call initialize — GLiNER stays unavailable

    const result = await fallbackScanner.scan(
      "John Smith at john@example.com",
    );

    // Should still find the email via regex
    const email = result.entities.find((e) => e.label === "EMAIL");
    expect(email).toBeDefined();
    expect(email!.source).toBe("regex");

    // Should NOT find person because GLiNER is not available
    const person = result.entities.find((e) => e.label === "PERSON");
    expect(person).toBeUndefined();
  });

  it("empty text returns empty entities", async () => {
    const result = await scanner.scan("");

    expect(result.entities).toEqual([]);
    expect(result.text).toBe("");
  });

  it("entities are sorted by start position after merge", async () => {
    const result = await scanner.scan(
      "John Smith can be reached at john@example.com for details.",
    );

    for (let i = 1; i < result.entities.length; i++) {
      expect(result.entities[i].start).toBeGreaterThanOrEqual(
        result.entities[i - 1].start,
      );
    }
  });

  it("passes custom_entities from config to GLiNER engine", async () => {
    const customScanner = new Scanner(
      makeConfig({ custom_entities: ["product", "event"] }),
    );
    await customScanner.initialize();

    // Should not throw, custom labels are set on the engine
    const result = await customScanner.scan("John Smith attended the event.");
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
  });

  it("handles text with only regex-detectable entities", async () => {
    const result = await scanner.scan(
      "Send to test@example.com and call 555-123-4567.",
    );

    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    const email = result.entities.find((e) => e.label === "EMAIL");
    expect(email).toBeDefined();
  });

  it("handles text with no detectable entities", async () => {
    const result = await scanner.scan("Hello world, this is a simple test.");

    expect(result.entities).toEqual([]);
    expect(result.text).toBe("Hello world, this is a simple test.");
  });
});
