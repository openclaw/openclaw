// RI-012 — Task Decomposer skill artifact tests
//
// Skills are prompt injections, not code, so there's no runtime behavior
// to unit-test directly. What we CAN validate deterministically:
//   1. schema.json is valid JSON Schema draft-07.
//   2. The inline example output in SKILL.md parses, conforms to schema,
//      and satisfies the soft constraints the SKILL.md documents.
//   3. The SKILL.md frontmatter parses and sets the cert_tier / version
//      / variantId fields the runtime expects.
//
// These are artifact tests — they fail loudly when someone edits the
// skill and breaks its own schema, which is the exact regression we
// want to catch.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvPkg from "ajv";
import { resolveOpenClawMetadata } from "./frontmatter.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";

const Ajv = AjvPkg as unknown as new (opts?: object) => {
  compile: (schema: object) => ((data: unknown) => boolean) & {
    errors?: unknown;
  };
};

// src/agents/skills/ → ../../../skills/task-decomposer/
const SKILL_DIR = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "..",
  "..",
  "skills",
  "task-decomposer",
);

function readSkillMd(): string {
  return readFileSync(join(SKILL_DIR, "SKILL.md"), "utf-8");
}

function readSchemaJson(): object {
  const raw = readFileSync(join(SKILL_DIR, "schema.json"), "utf-8");
  return JSON.parse(raw) as object;
}

function extractFirstJsonBlock(
  markdown: string,
  after: string,
): unknown | null {
  const start = markdown.indexOf(after);
  if (start < 0) return null;
  const fence = markdown.indexOf("```json", start);
  if (fence < 0) return null;
  const closeFence = markdown.indexOf("```", fence + 7);
  if (closeFence < 0) return null;
  const jsonText = markdown.slice(fence + 7, closeFence).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

describe("task-decomposer schema", () => {
  it("schema.json parses and compiles under ajv draft-07", () => {
    const schema = readSchemaJson();
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    expect(typeof validate).toBe("function");
  });

  it("has the expected top-level fields", () => {
    const schema = readSchemaJson() as Record<string, unknown>;
    expect(schema["$id"]).toContain("task-decomposer");
    const props = schema["properties"] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "goal",
        "depth",
        "risk_level",
        "slices",
        "global_risks",
        "assumptions",
      ]),
    );
  });

  it("defines a slice shape with the required fields", () => {
    const schema = readSchemaJson() as Record<string, unknown>;
    const defs = schema["definitions"] as Record<string, unknown>;
    const slice = defs["slice"] as Record<string, unknown>;
    expect(slice["required"]).toEqual(
      expect.arrayContaining([
        "slice_id",
        "title",
        "end_to_end_scope",
        "acceptance_criteria",
        "test_hooks",
        "est_agent_hours",
      ]),
    );
  });
});

describe("task-decomposer SKILL.md example", () => {
  it("the auth-system example parses and validates against schema", () => {
    const md = readSkillMd();
    const example = extractFirstJsonBlock(
      md,
      'Goal: "Build a user authentication system"',
    );
    expect(example).not.toBeNull();

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(readSchemaJson());
    const ok = validate(example);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(validate.errors);
    }
    expect(ok).toBe(true);
  });

  it("the example has exactly `depth` slices", () => {
    const md = readSkillMd();
    const example = extractFirstJsonBlock(
      md,
      'Goal: "Build a user authentication system"',
    ) as { depth: number; slices: unknown[] };
    expect(example.slices.length).toBe(example.depth);
  });

  it("every slice has at least one acceptance_criteria and test_hook", () => {
    const md = readSkillMd();
    const example = extractFirstJsonBlock(
      md,
      'Goal: "Build a user authentication system"',
    ) as {
      slices: Array<{ acceptance_criteria: string[]; test_hooks: string[] }>;
    };
    for (const slice of example.slices) {
      expect(slice.acceptance_criteria.length).toBeGreaterThanOrEqual(1);
      expect(slice.test_hooks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("slice dependencies form a valid DAG referencing earlier slice ids", () => {
    const md = readSkillMd();
    const example = extractFirstJsonBlock(
      md,
      'Goal: "Build a user authentication system"',
    ) as {
      slices: Array<{ slice_id: string; dependencies?: string[] }>;
    };
    const seen = new Set<string>();
    for (const slice of example.slices) {
      for (const dep of slice.dependencies ?? []) {
        expect(seen.has(dep)).toBe(true); // dep must appear earlier
      }
      seen.add(slice.slice_id);
    }
  });

  it("total est_agent_hours respects the 2 × depth soft cap", () => {
    const md = readSkillMd();
    const example = extractFirstJsonBlock(
      md,
      'Goal: "Build a user authentication system"',
    ) as { depth: number; slices: Array<{ est_agent_hours: number }> };
    const total = example.slices.reduce((a, s) => a + s.est_agent_hours, 0);
    expect(total).toBeLessThanOrEqual(2 * example.depth);
  });

  it("every slice has security_considerations at risk_level=medium or higher", () => {
    const md = readSkillMd();
    const example = extractFirstJsonBlock(
      md,
      'Goal: "Build a user authentication system"',
    ) as {
      risk_level: string;
      slices: Array<{ security_considerations?: string[] }>;
    };
    if (example.risk_level !== "low") {
      for (const slice of example.slices) {
        expect(slice.security_considerations?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("task-decomposer frontmatter", () => {
  it("parses cert_tier, version, variantId from the SKILL.md frontmatter", () => {
    const md = readSkillMd();
    const frontmatter = parseFrontmatterBlock(md);
    const metadata = resolveOpenClawMetadata(frontmatter);
    expect(metadata).toBeDefined();
    expect(metadata?.certTier).toBe("certified");
    expect(metadata?.version).toBe("1.0.0");
    expect(metadata?.variantId).toBe("control");
  });

  it("declares user-invocable: true", () => {
    const md = readSkillMd();
    expect(md).toMatch(/user-invocable:\s*true/);
  });

  it("has an emoji metadata field", () => {
    const md = readSkillMd();
    const frontmatter = parseFrontmatterBlock(md);
    const metadata = resolveOpenClawMetadata(frontmatter);
    expect(metadata?.emoji).toBeTruthy();
  });
});
