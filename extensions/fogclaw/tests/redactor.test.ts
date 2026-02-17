import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { redact } from "../src/redactor.js";
import type { Entity } from "../src/types.js";

// Helper to build Entity objects concisely
function entity(
  text: string,
  label: string,
  start: number,
  end: number,
  source: "regex" | "gliner" = "regex",
  confidence = 1.0,
): Entity {
  return { text, label, start, end, confidence, source };
}

describe("redact", () => {
  // ── token strategy ──────────────────────────────────────────────

  describe("token strategy", () => {
    it("replaces a single EMAIL entity with [EMAIL_1]", () => {
      const text = "Contact john@example.com for info.";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 8, 24),
      ];

      const result = redact(text, entities, "token");

      expect(result.redacted_text).toBe("Contact [EMAIL_1] for info.");
    });

    it("replaces a single PHONE entity with [PHONE_1]", () => {
      const text = "Call 555-123-4567 now.";
      const entities: Entity[] = [
        entity("555-123-4567", "PHONE", 5, 17),
      ];

      const result = redact(text, entities, "token");

      expect(result.redacted_text).toBe("Call [PHONE_1] now.");
    });

    it("increments counter for multiple entities of the same type", () => {
      const text = "Email alice@a.com and bob@b.com please.";
      const entities: Entity[] = [
        entity("alice@a.com", "EMAIL", 6, 17),
        entity("bob@b.com", "EMAIL", 22, 31),
      ];

      const result = redact(text, entities, "token");

      // Processing order is descending by start position, so bob@b.com
      // (start=22) gets [EMAIL_1] and alice@a.com (start=6) gets [EMAIL_2]
      expect(result.redacted_text).toBe(
        "Email [EMAIL_2] and [EMAIL_1] please.",
      );
      expect(result.mapping["[EMAIL_1]"]).toBe("bob@b.com");
      expect(result.mapping["[EMAIL_2]"]).toBe("alice@a.com");
    });

    it("uses separate counters for different entity types", () => {
      const text = "Email john@example.com or call 555-0000.";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 6, 22),
        entity("555-0000", "PHONE", 31, 39),
      ];

      const result = redact(text, entities, "token");

      expect(result.redacted_text).toBe(
        "Email [EMAIL_1] or call [PHONE_1].",
      );
    });

    it("defaults to token strategy when none is specified", () => {
      const text = "Hi john@example.com";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 3, 19),
      ];

      const result = redact(text, entities);

      expect(result.redacted_text).toBe("Hi [EMAIL_1]");
    });
  });

  // ── mask strategy ───────────────────────────────────────────────

  describe("mask strategy", () => {
    it("replaces entity with asterisks matching original length", () => {
      const text = "Contact john@example.com for info.";
      //                     ^               ^
      //                     8              24 (16 chars)
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 8, 24),
      ];

      const result = redact(text, entities, "mask");

      expect(result.redacted_text).toBe("Contact **************** for info.");
      // "john@example.com" is 16 chars -> 16 asterisks
      expect(result.redacted_text.slice(8, 24)).toBe("*".repeat(16));
    });

    it("uses at least one asterisk for empty-text entity", () => {
      const text = "A B";
      const entities: Entity[] = [
        entity("", "UNKNOWN", 1, 1),
      ];

      const result = redact(text, entities, "mask");

      expect(result.redacted_text).toBe("A* B");
    });

    it("masks multiple entities independently", () => {
      const text = "Name: Alice, Phone: 12345";
      const entities: Entity[] = [
        entity("Alice", "PERSON", 6, 11),
        entity("12345", "PHONE", 20, 25),
      ];

      const result = redact(text, entities, "mask");

      expect(result.redacted_text).toBe("Name: *****, Phone: *****");
    });
  });

  // ── hash strategy ───────────────────────────────────────────────

  describe("hash strategy", () => {
    it("replaces entity with [LABEL_sha256prefix]", () => {
      const text = "Contact john@example.com for info.";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 8, 24),
      ];

      const expectedDigest = createHash("sha256")
        .update("john@example.com")
        .digest("hex")
        .slice(0, 12);

      const result = redact(text, entities, "hash");

      expect(result.redacted_text).toBe(
        `Contact [EMAIL_${expectedDigest}] for info.`,
      );
    });

    it("produces consistent hashes across calls", () => {
      const text = "Hi john@example.com";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 3, 19),
      ];

      const r1 = redact(text, entities, "hash");
      const r2 = redact(text, entities, "hash");

      expect(r1.redacted_text).toBe(r2.redacted_text);
    });

    it("produces different hashes for different entity text", () => {
      const text1 = "Hi alice@a.com";
      const text2 = "Hi bobby@b.com";
      const e1: Entity[] = [entity("alice@a.com", "EMAIL", 3, 14)];
      const e2: Entity[] = [entity("bobby@b.com", "EMAIL", 3, 14)];

      const r1 = redact(text1, e1, "hash");
      const r2 = redact(text2, e2, "hash");

      expect(r1.redacted_text).not.toBe(r2.redacted_text);
    });
  });

  // ── mapping ─────────────────────────────────────────────────────

  describe("mapping", () => {
    it("maps replacement tokens back to original text (token strategy)", () => {
      const text = "Email john@example.com or call 555-0000.";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 6, 22),
        entity("555-0000", "PHONE", 31, 39),
      ];

      const result = redact(text, entities, "token");

      expect(result.mapping).toEqual({
        "[EMAIL_1]": "john@example.com",
        "[PHONE_1]": "555-0000",
      });
    });

    it("maps replacement masks back to original text (mask strategy)", () => {
      const text = "Call 555-0000 now.";
      const entities: Entity[] = [
        entity("555-0000", "PHONE", 5, 13),
      ];

      const result = redact(text, entities, "mask");

      expect(result.mapping["********"]).toBe("555-0000");
    });

    it("maps replacement hashes back to original text (hash strategy)", () => {
      const text = "Hi Alice";
      const entities: Entity[] = [
        entity("Alice", "PERSON", 3, 8),
      ];

      const result = redact(text, entities, "hash");

      const digest = createHash("sha256")
        .update("Alice")
        .digest("hex")
        .slice(0, 12);
      expect(result.mapping[`[PERSON_${digest}]`]).toBe("Alice");
    });
  });

  // ── empty entities ──────────────────────────────────────────────

  describe("empty entities", () => {
    it("returns original text unchanged when entities array is empty", () => {
      const text = "Nothing to redact here.";

      const result = redact(text, []);

      expect(result.redacted_text).toBe(text);
      expect(result.mapping).toEqual({});
      expect(result.entities).toEqual([]);
    });

    it("returns original text with all strategies when no entities", () => {
      const text = "Still nothing.";

      for (const strategy of ["token", "mask", "hash"] as const) {
        const result = redact(text, [], strategy);
        expect(result.redacted_text).toBe(text);
        expect(result.mapping).toEqual({});
      }
    });
  });

  // ── entity ordering / offset integrity ──────────────────────────

  describe("entity ordering", () => {
    it("handles entities given in reverse order without offset corruption", () => {
      const text = "Name: Alice, Email: alice@a.com";
      const entities: Entity[] = [
        // Provided in reverse order (end of string first)
        entity("alice@a.com", "EMAIL", 20, 31),
        entity("Alice", "PERSON", 6, 11),
      ];

      const result = redact(text, entities, "token");

      expect(result.redacted_text).toBe(
        "Name: [PERSON_1], Email: [EMAIL_1]",
      );
    });

    it("handles entities given in forward order without offset corruption", () => {
      const text = "Name: Alice, Email: alice@a.com";
      const entities: Entity[] = [
        entity("Alice", "PERSON", 6, 11),
        entity("alice@a.com", "EMAIL", 20, 31),
      ];

      const result = redact(text, entities, "token");

      expect(result.redacted_text).toBe(
        "Name: [PERSON_1], Email: [EMAIL_1]",
      );
    });

    it("handles three entities in random order", () => {
      const text = "A: Alice B: bob@b.com C: 555-0000";
      const entities: Entity[] = [
        entity("bob@b.com", "EMAIL", 12, 21),
        entity("555-0000", "PHONE", 25, 33),
        entity("Alice", "PERSON", 3, 8),
      ];

      const result = redact(text, entities, "token");

      expect(result.redacted_text).toBe(
        "A: [PERSON_1] B: [EMAIL_1] C: [PHONE_1]",
      );
    });

    it("does not mutate the original entities array", () => {
      const text = "Name: Alice, Email: alice@a.com";
      const entities: Entity[] = [
        entity("alice@a.com", "EMAIL", 20, 31),
        entity("Alice", "PERSON", 6, 11),
      ];
      const originalOrder = [...entities];

      redact(text, entities, "token");

      expect(entities).toEqual(originalOrder);
    });
  });

  // ── returned entities ───────────────────────────────────────────

  describe("returned entities", () => {
    it("returns the original entities array in the result", () => {
      const text = "Hi john@example.com";
      const entities: Entity[] = [
        entity("john@example.com", "EMAIL", 3, 19),
      ];

      const result = redact(text, entities, "token");

      expect(result.entities).toBe(entities);
    });
  });
});
