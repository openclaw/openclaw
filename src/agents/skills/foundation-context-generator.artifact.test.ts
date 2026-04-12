// RI-002 — Foundation Context Generator skill artifact tests
//
// Validates the SKILL.md frontmatter + the 5 vertical templates exist
// and contain the expected section markers. Like task-decomposer, these
// are artifact tests — they fail when someone edits the skill data in
// a way that breaks the contract the loader + Mission Control rely on.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawMetadata } from "./frontmatter.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";

const SKILL_DIR = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "..",
  "..",
  "skills",
  "foundation-context-generator",
);
const TEMPLATES_DIR = join(SKILL_DIR, "templates");
const VERTICAL_TEMPLATES = [
  "legal",
  "property-management",
  "healthcare",
  "agency",
  "generic",
];

function readFile(relPath: string): string {
  return readFileSync(join(SKILL_DIR, relPath), "utf-8");
}

describe("foundation-context-generator — SKILL.md frontmatter", () => {
  it("parses cert_tier=certified, version=1.0.0, variantId=control", () => {
    const md = readFile("SKILL.md");
    const frontmatter = parseFrontmatterBlock(md);
    const metadata = resolveOpenClawMetadata(frontmatter);
    expect(metadata).toBeDefined();
    expect(metadata?.certTier).toBe("certified");
    expect(metadata?.version).toBe("1.0.0");
    expect(metadata?.variantId).toBe("control");
  });

  it("declares user-invocable: true", () => {
    const md = readFile("SKILL.md");
    expect(md).toMatch(/user-invocable:\s*true/);
  });

  it("names the four canonical output sections", () => {
    const md = readFile("SKILL.md");
    expect(md).toContain("[BUSINESS_CONTEXT]");
    expect(md).toContain("[TECHNICAL_SPECIFICS]");
    expect(md).toContain("[DECISION_RULES]");
    expect(md).toContain("[VERTICAL_EXTENSIONS]");
  });

  it("references all 5 vertical templates by name", () => {
    const md = readFile("SKILL.md");
    for (const vertical of VERTICAL_TEMPLATES) {
      expect(md).toContain(`templates/${vertical}.md`);
    }
  });

  it("instructs the user to save output to STATE_DIR/tenant-context/CLAUDE.md", () => {
    const md = readFile("SKILL.md");
    expect(md).toMatch(/tenant-context[/\\]CLAUDE\.md/i);
  });
});

describe("foundation-context-generator — vertical templates", () => {
  for (const vertical of VERTICAL_TEMPLATES) {
    it(`${vertical}.md exists`, () => {
      expect(existsSync(join(TEMPLATES_DIR, `${vertical}.md`))).toBe(true);
    });

    it(`${vertical}.md starts with the [VERTICAL_EXTENSIONS] section`, () => {
      const content = readFileSync(
        join(TEMPLATES_DIR, `${vertical}.md`),
        "utf-8",
      );
      expect(content).toContain("[VERTICAL_EXTENSIONS]");
    });

    it(`${vertical}.md is non-trivially populated (≥ 500 bytes)`, () => {
      const content = readFileSync(
        join(TEMPLATES_DIR, `${vertical}.md`),
        "utf-8",
      );
      expect(content.length).toBeGreaterThanOrEqual(500);
    });
  }

  it("legal template enforces UPL guardrails", () => {
    const legal = readFileSync(join(TEMPLATES_DIR, "legal.md"), "utf-8");
    expect(legal).toMatch(/UPL|Unauthorized Practice of Law/);
    expect(legal).toMatch(/MUST NOT|must not/);
  });

  it("healthcare template enforces HIPAA boundaries", () => {
    const healthcare = readFileSync(
      join(TEMPLATES_DIR, "healthcare.md"),
      "utf-8",
    );
    expect(healthcare).toMatch(/HIPAA|PHI/);
    expect(healthcare).toMatch(/no-diagnosis|never diagnose|MUST NOT/i);
  });

  it("property-management template defines SLA tiers", () => {
    const pm = readFileSync(
      join(TEMPLATES_DIR, "property-management.md"),
      "utf-8",
    );
    expect(pm.toLowerCase()).toContain("emergency");
    expect(pm.toLowerCase()).toContain("urgent");
    expect(pm.toLowerCase()).toContain("standard");
  });

  it("agency template warns about cross-client confidentiality", () => {
    const agency = readFileSync(join(TEMPLATES_DIR, "agency.md"), "utf-8");
    expect(agency).toMatch(/competitive conflicts?|confidential/i);
    expect(agency.toLowerCase()).toContain("revision");
  });
});
