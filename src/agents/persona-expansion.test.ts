/**
 * Persona expansion engine tests.
 *
 * Tests the parser, section mapper, agent file generator, and full
 * expansion orchestrator.
 */
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { parsePersona, expandPersona, loadPersonaBySlug } from "./persona-expansion.js";

const PERSONAS_DIR = join(import.meta.dirname, "..", "..", "agents", "personas");

// ── Sample persona content for unit tests ───────────────────────────────────

const VALID_PERSONA = `---
slug: test-engineer
name: Test Engineer
description: A test persona for unit testing
category: testing
role: QA Engineer
department: testing
emoji: "\u{1F9EA}"
vibe: Methodical and thorough.
tags: [testing, qa, automation]
version: 1.0.0
author: Test
tools:
  - read
  - exec
capabilities:
  - test_automation
  - code_review
tier: 3
---

# Test Engineer

> A test persona for unit testing the expansion engine.

## Identity

- **Role:** QA Engineer
- **Focus:** Test automation, regression testing, CI/CD pipelines
- **Communication:** Precise, evidence-based
- **Vibe:** Methodical and thorough.

## Core Mission

Ensure every code change ships with confidence. Build and maintain test
suites that catch regressions before users do.

## Critical Rules

- Never skip tests to meet deadlines
- Every bug fix must include a regression test
- Flaky tests are bugs — fix them immediately

## Workflow

1. Review changed files for test coverage gaps
2. Write/update tests for new functionality
3. Run full test suite and report results
4. Flag untested edge cases

## Deliverables

- Test coverage reports
- Regression test suites
- CI pipeline health dashboards

## Communication Style

- Lead with pass/fail status, then details
- Include reproduction steps for failures
- Quantify coverage with percentages

## Heartbeat Guidance

- Monitor CI pipeline health daily
- Track flaky test trends weekly
- Report coverage delta on each PR
`;

const PERSONA_NO_HEARTBEAT = `---
slug: minimal-agent
name: Minimal Agent
description: Agent without heartbeat section
category: testing
role: Minimal
department: testing
emoji: "\u{2699}"
---

# Minimal Agent

## Identity

- **Role:** Minimal
- **Focus:** Minimalism

## Core Mission

Do the minimum required.

## Critical Rules

- Keep it simple
`;

// ── parsePersona tests ──────────────────────────────────────────────────────

describe("parsePersona", () => {
  test("parses valid persona with all sections", () => {
    const result = parsePersona(VALID_PERSONA);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.frontmatter.slug).toBe("test-engineer");
      expect(result.frontmatter.name).toBe("Test Engineer");
      expect(result.frontmatter.tools).toEqual(["read", "exec"]);
      expect(result.frontmatter.tier).toBe(3);
      expect(result.sections.has("Identity")).toBe(true);
      expect(result.sections.has("Core Mission")).toBe(true);
      expect(result.sections.has("Critical Rules")).toBe(true);
      expect(result.sections.has("Workflow")).toBe(true);
      expect(result.sections.has("Deliverables")).toBe(true);
      expect(result.sections.has("Communication Style")).toBe(true);
      expect(result.sections.has("Heartbeat Guidance")).toBe(true);
    }
  });

  test("returns error for missing frontmatter", () => {
    const result = parsePersona("# Just markdown\n\nNo frontmatter here.");
    expect("error" in result).toBe(true);
  });

  test("returns error for invalid YAML", () => {
    const result = parsePersona("---\n{{invalid\n---\n# Agent");
    expect("error" in result).toBe(true);
  });

  test("returns error for invalid frontmatter schema", () => {
    const result = parsePersona("---\nslug: test\n---\n# Agent");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("validation failed");
    }
  });

  test("handles persona without optional sections", () => {
    const result = parsePersona(PERSONA_NO_HEARTBEAT);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.sections.has("Heartbeat Guidance")).toBe(false);
      expect(result.sections.has("Identity")).toBe(true);
      expect(result.sections.has("Core Mission")).toBe(true);
    }
  });
});

// ── expandPersona tests ─────────────────────────────────────────────────────

describe("expandPersona", () => {
  test("expands valid persona into agent file + workspace files", async () => {
    const result = await expandPersona(VALID_PERSONA, {
      agentName: "TestBot",
      agentId: "testbot",
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      // AGENT.md should have frontmatter with persona field
      expect(result.agentMd).toContain("persona: test-engineer");
      expect(result.agentMd).toContain("id: testbot");
      expect(result.agentMd).toContain("name: TestBot");
      // Tools should be mapped from flat list to { allow: [...] }
      expect(result.agentMd).toContain("allow:");
      expect(result.agentMd).toContain("- read");
      expect(result.agentMd).toContain("- exec");

      // Workspace files
      const fileNames = result.workspaceFiles.map((f) => f.name);
      expect(fileNames).toContain("IDENTITY.md");
      expect(fileNames).toContain("SOUL.md");
      expect(fileNames).toContain("USER.md");
      expect(fileNames).toContain("HEARTBEAT.md");

      // SOUL.md should contain mission + rules + communication style
      const soul = result.workspaceFiles.find((f) => f.name === "SOUL.md")!;
      expect(soul.content).toContain("## Core Mission");
      expect(soul.content).toContain("## Critical Rules");
      expect(soul.content).toContain("## Communication Style");

      // IDENTITY.md should contain role info
      const identity = result.workspaceFiles.find((f) => f.name === "IDENTITY.md")!;
      expect(identity.content).toContain("QA Engineer");
      expect(identity.content).toContain("TestBot");

      // USER.md should contain persona metadata
      const user = result.workspaceFiles.find((f) => f.name === "USER.md")!;
      expect(user.content).toContain("Test Engineer");
      expect(user.content).toContain("test-engineer");

      // HEARTBEAT.md should exist since persona has heartbeat section
      const heartbeat = result.workspaceFiles.find((f) => f.name === "HEARTBEAT.md")!;
      expect(heartbeat.content).toContain("CI pipeline");
    }
  });

  test("skips HEARTBEAT.md when persona has no heartbeat section", async () => {
    const result = await expandPersona(PERSONA_NO_HEARTBEAT, {
      agentName: "Mini",
      agentId: "mini",
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      const fileNames = result.workspaceFiles.map((f) => f.name);
      expect(fileNames).not.toContain("HEARTBEAT.md");
      expect(fileNames).toContain("IDENTITY.md");
      expect(fileNames).toContain("SOUL.md");
      expect(fileNames).toContain("USER.md");
    }
  });

  test("fails on persona missing required sections", async () => {
    const badPersona = `---
slug: bad
name: Bad
description: Missing sections
category: testing
role: Bad
department: testing
emoji: "\u{274C}"
---

# Bad Agent

Only a title, no required sections.
`;
    const result = await expandPersona(badPersona, {
      agentName: "Bad",
      agentId: "bad",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("missing required section");
    }
  });

  test("applies user overrides to agent frontmatter", async () => {
    const result = await expandPersona(VALID_PERSONA, {
      agentName: "Custom",
      agentId: "custom",
      overrides: { tier: 1, department: "operations" },
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.agentMd).toContain("tier: 1");
      expect(result.agentMd).toContain("department: operations");
    }
  });
});

// ── loadPersonaBySlug integration test ──────────────────────────────────────

describe("loadPersonaBySlug", () => {
  test("loads security-engineer persona from disk", async () => {
    const result = await loadPersonaBySlug(PERSONAS_DIR, "security-engineer");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.frontmatter.slug).toBe("security-engineer");
      expect(result.frontmatter.category).toBe("engineering");
      expect(result.sections.has("Identity")).toBe(true);
    }
  });

  test("returns error for non-existent slug", async () => {
    const result = await loadPersonaBySlug(PERSONAS_DIR, "does-not-exist");
    expect("error" in result).toBe(true);
  });

  test("full expansion from disk persona", async () => {
    const persona = await loadPersonaBySlug(PERSONAS_DIR, "code-reviewer");
    expect("error" in persona).toBe(false);
    if ("error" in persona) {
      return;
    }

    const result = await expandPersona(persona, {
      agentName: "ReviewBot",
      agentId: "reviewbot",
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.agentMd).toContain("persona: code-reviewer");
      expect(result.agentMd).toContain("name: ReviewBot");
      expect(result.workspaceFiles.length).toBeGreaterThanOrEqual(3);
    }
  });
});
