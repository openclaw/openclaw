/**
 * Tests for schema.ts — Schema Validation & Helpers.
 *
 * Tests the exported pure functions: escapeLucene(), validateRelationshipType(),
 * and the exported constants and types.
 */

import { describe, it, expect } from "vitest";
import type { MemorySource } from "./schema.js";
import {
  escapeLucene,
  validateRelationshipType,
  ALLOWED_RELATIONSHIP_TYPES,
  MEMORY_CATEGORIES,
  ENTITY_TYPES,
} from "./schema.js";

// ============================================================================
// escapeLucene()
// ============================================================================

describe("escapeLucene", () => {
  it("should return normal text unchanged", () => {
    expect(escapeLucene("hello world")).toBe("hello world");
  });

  it("should return empty string unchanged", () => {
    expect(escapeLucene("")).toBe("");
  });

  it("should escape plus sign", () => {
    expect(escapeLucene("a+b")).toBe("a\\+b");
  });

  it("should escape minus sign", () => {
    expect(escapeLucene("a-b")).toBe("a\\-b");
  });

  it("should escape ampersand", () => {
    expect(escapeLucene("a&b")).toBe("a\\&b");
  });

  it("should escape pipe", () => {
    expect(escapeLucene("a|b")).toBe("a\\|b");
  });

  it("should escape exclamation mark", () => {
    expect(escapeLucene("hello!")).toBe("hello\\!");
  });

  it("should escape parentheses", () => {
    expect(escapeLucene("(group)")).toBe("\\(group\\)");
  });

  it("should escape curly braces", () => {
    expect(escapeLucene("{range}")).toBe("\\{range\\}");
  });

  it("should escape square brackets", () => {
    expect(escapeLucene("[range]")).toBe("\\[range\\]");
  });

  it("should escape caret", () => {
    expect(escapeLucene("boost^2")).toBe("boost\\^2");
  });

  it("should escape double quotes", () => {
    expect(escapeLucene('"exact"')).toBe('\\"exact\\"');
  });

  it("should escape tilde", () => {
    expect(escapeLucene("fuzzy~")).toBe("fuzzy\\~");
  });

  it("should escape asterisk", () => {
    expect(escapeLucene("wild*")).toBe("wild\\*");
  });

  it("should escape question mark", () => {
    expect(escapeLucene("single?")).toBe("single\\?");
  });

  it("should escape colon", () => {
    expect(escapeLucene("field:value")).toBe("field\\:value");
  });

  it("should escape backslash", () => {
    expect(escapeLucene("path\\file")).toBe("path\\\\file");
  });

  it("should escape forward slash", () => {
    expect(escapeLucene("a/b")).toBe("a\\/b");
  });

  it("should escape multiple special characters in one string", () => {
    expect(escapeLucene("(a+b) && c*")).toBe("\\(a\\+b\\) \\&\\& c\\*");
  });

  it("should handle mixed normal and special characters", () => {
    expect(escapeLucene("hello world! [test]")).toBe("hello world\\! \\[test\\]");
  });

  it("should handle strings with only special characters", () => {
    expect(escapeLucene("+-")).toBe("\\+\\-");
  });
});

// ============================================================================
// validateRelationshipType()
// ============================================================================

describe("validateRelationshipType", () => {
  describe("valid relationship types", () => {
    it("should accept WORKS_AT", () => {
      expect(validateRelationshipType("WORKS_AT")).toBe(true);
    });

    it("should accept LIVES_AT", () => {
      expect(validateRelationshipType("LIVES_AT")).toBe(true);
    });

    it("should accept KNOWS", () => {
      expect(validateRelationshipType("KNOWS")).toBe(true);
    });

    it("should accept MARRIED_TO", () => {
      expect(validateRelationshipType("MARRIED_TO")).toBe(true);
    });

    it("should accept PREFERS", () => {
      expect(validateRelationshipType("PREFERS")).toBe(true);
    });

    it("should accept DECIDED", () => {
      expect(validateRelationshipType("DECIDED")).toBe(true);
    });

    it("should accept RELATED_TO", () => {
      expect(validateRelationshipType("RELATED_TO")).toBe(true);
    });

    it("should accept all ALLOWED_RELATIONSHIP_TYPES", () => {
      for (const type of ALLOWED_RELATIONSHIP_TYPES) {
        expect(validateRelationshipType(type)).toBe(true);
      }
    });
  });

  describe("invalid relationship types", () => {
    it("should reject unknown relationship type", () => {
      expect(validateRelationshipType("HATES")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(validateRelationshipType("")).toBe(false);
    });

    it("should be case sensitive — lowercase is rejected", () => {
      expect(validateRelationshipType("works_at")).toBe(false);
    });

    it("should be case sensitive — mixed case is rejected", () => {
      expect(validateRelationshipType("Works_At")).toBe(false);
    });

    it("should reject types with extra whitespace", () => {
      expect(validateRelationshipType(" WORKS_AT ")).toBe(false);
    });

    it("should reject potential Cypher injection", () => {
      expect(validateRelationshipType("WORKS_AT]->(n) DELETE n//")).toBe(false);
    });
  });
});

// ============================================================================
// Exported Constants
// ============================================================================

describe("exported constants", () => {
  it("MEMORY_CATEGORIES should contain expected categories", () => {
    expect(MEMORY_CATEGORIES).toContain("preference");
    expect(MEMORY_CATEGORIES).toContain("fact");
    expect(MEMORY_CATEGORIES).toContain("decision");
    expect(MEMORY_CATEGORIES).toContain("entity");
    expect(MEMORY_CATEGORIES).toContain("other");
  });

  it("ENTITY_TYPES should contain expected types", () => {
    expect(ENTITY_TYPES).toContain("person");
    expect(ENTITY_TYPES).toContain("organization");
    expect(ENTITY_TYPES).toContain("location");
    expect(ENTITY_TYPES).toContain("event");
    expect(ENTITY_TYPES).toContain("concept");
  });

  it("ALLOWED_RELATIONSHIP_TYPES should be a Set", () => {
    expect(ALLOWED_RELATIONSHIP_TYPES).toBeInstanceOf(Set);
    expect(ALLOWED_RELATIONSHIP_TYPES.size).toBe(7);
  });
});

// ============================================================================
// MemorySource Type
// ============================================================================

describe("MemorySource type", () => {
  it("should accept 'auto-capture-assistant' as a valid MemorySource value", () => {
    // Type-level check: this assignment should compile without error
    const source: MemorySource = "auto-capture-assistant";
    expect(source).toBe("auto-capture-assistant");
  });

  it("should accept all MemorySource values", () => {
    const sources: MemorySource[] = [
      "user",
      "auto-capture",
      "auto-capture-assistant",
      "memory-watcher",
      "import",
    ];
    expect(sources).toHaveLength(5);
  });
});
