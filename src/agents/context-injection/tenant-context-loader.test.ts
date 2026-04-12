// RI-002 — Tenant Context Loader tests

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __clearTenantContextCacheForTest,
  applyTenantContextToPrompt,
  DEFAULT_MAX_CONTEXT_BYTES,
  extractSection,
  loadTenantContext,
} from "./tenant-context-loader.js";

let stateDir: string;

beforeEach(() => {
  __clearTenantContextCacheForTest();
  stateDir = mkdtempSync(join(tmpdir(), "tenant-context-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  __clearTenantContextCacheForTest();
});

function writeContext(content: string): string {
  const dir = join(stateDir, "tenant-context");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "CLAUDE.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const SAMPLE_CONTEXT = `# Acme Co — Agent Context

## [BUSINESS_CONTEXT]
Acme sells enterprise widgets to Fortune 500 procurement teams.
Primary KPI: annual recurring revenue.
Brand voice: direct, technical, confident.
Do-not-say list: "synergy", "leverage", "circle back".

## [TECHNICAL_SPECIFICS]
Stack: TypeScript, Postgres, Vercel.
Naming: kebab-case.
MCP: HubSpot, Notion, GitHub.
Off-limits: Production DB, payroll system.

## [DECISION_RULES]
Speed vs accuracy: prefer accuracy for customer-facing content.
Content risk tolerance: moderate.
Approval chain: draft → account lead → send.
Uncertainty default: ask human.

## [VERTICAL_EXTENSIONS]
Agency-specific template content here.
`;

describe("loadTenantContext", () => {
  it("returns null when the context file does not exist", () => {
    const result = loadTenantContext({ stateDir });
    expect(result).toBeNull();
  });

  it("loads and parses all four canonical sections", () => {
    writeContext(SAMPLE_CONTEXT);
    const result = loadTenantContext({ stateDir });
    expect(result).not.toBeNull();
    expect(result!.businessContext).toContain("Acme sells enterprise widgets");
    expect(result!.technicalSpecifics).toContain("TypeScript, Postgres, Vercel");
    expect(result!.decisionRules).toContain("prefer accuracy");
    expect(result!.verticalExtensions).toContain("Agency-specific template");
  });

  it("returns empty strings for missing sections (gracefully degrades)", () => {
    writeContext(`# Minimal tenant\n\n## [BUSINESS_CONTEXT]\nJust the basics.\n`);
    const result = loadTenantContext({ stateDir });
    expect(result).not.toBeNull();
    expect(result!.businessContext).toContain("Just the basics");
    expect(result!.technicalSpecifics).toBe("");
    expect(result!.decisionRules).toBe("");
    expect(result!.verticalExtensions).toBe("");
  });

  it("caches on mtime and returns the same object on subsequent reads", () => {
    writeContext(SAMPLE_CONTEXT);
    const first = loadTenantContext({ stateDir });
    const second = loadTenantContext({ stateDir });
    expect(first).toBe(second); // reference equality → cache hit
  });

  it("invalidates the cache when mtime changes", () => {
    const filePath = writeContext(SAMPLE_CONTEXT);
    const first = loadTenantContext({ stateDir });
    expect(first).not.toBeNull();

    // Overwrite with new content + bump mtime forward 10 seconds
    writeFileSync(
      filePath,
      `## [BUSINESS_CONTEXT]\nFresh content.\n`,
      "utf-8",
    );
    const future = new Date(Date.now() + 10_000);
    utimesSync(filePath, future, future);

    const second = loadTenantContext({ stateDir });
    expect(second).not.toBeNull();
    expect(second!.businessContext).toContain("Fresh content");
    expect(second).not.toBe(first);
  });

  it("truncates content that exceeds the size cap", () => {
    const big = "## [BUSINESS_CONTEXT]\n" + "x".repeat(100_000);
    writeContext(big);
    const result = loadTenantContext({ stateDir, maxBytes: 1_000 });
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.raw.length).toBeLessThanOrEqual(1_000);
  });

  it("respects DEFAULT_MAX_CONTEXT_BYTES when no cap is supplied", () => {
    // Just a smoke test — confirm the default constant is wired through
    writeContext(SAMPLE_CONTEXT);
    const result = loadTenantContext({ stateDir });
    expect(result!.truncated).toBe(false);
    expect(SAMPLE_CONTEXT.length).toBeLessThan(DEFAULT_MAX_CONTEXT_BYTES);
  });

  it("is section-case-insensitive", () => {
    writeContext(
      `## [business_context]\nlowercase section header\n\n## [Technical_Specifics]\nMixed case header\n`,
    );
    const result = loadTenantContext({ stateDir });
    expect(result!.businessContext).toContain("lowercase section header");
    expect(result!.technicalSpecifics).toContain("Mixed case header");
  });
});

describe("applyTenantContextToPrompt", () => {
  it("returns the prompt unchanged when context is null", () => {
    const out = applyTenantContextToPrompt("You are an agent.", null);
    expect(out).toBe("You are an agent.");
  });

  it("prepends context with a tenant header when context is present", () => {
    writeContext(SAMPLE_CONTEXT);
    const context = loadTenantContext({ stateDir });
    const out = applyTenantContextToPrompt("You are an agent.", context);
    expect(out).toMatch(/^# Tenant Context/);
    expect(out).toContain("Acme sells enterprise widgets");
    expect(out).toContain("---");
    expect(out).toContain("You are an agent.");
  });

  it("separates tenant context and base prompt with a horizontal rule", () => {
    writeContext(SAMPLE_CONTEXT);
    const context = loadTenantContext({ stateDir });
    const out = applyTenantContextToPrompt("Base prompt.", context);
    const parts = out.split(/\n---\n/);
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("Tenant Context");
    expect(parts[1]).toContain("Base prompt");
  });
});

describe("extractSection", () => {
  it("is resilient to trailing whitespace and case in the header", () => {
    const raw = `## [BUSINESS_CONTEXT]   \nhello\n\n## [TECHNICAL_SPECIFICS]\nworld\n`;
    expect(extractSection(raw, "business_context")).toBe("hello");
    expect(extractSection(raw, "technical_specifics")).toBe("world");
  });

  it("returns empty string for a missing section", () => {
    expect(extractSection("", "BUSINESS_CONTEXT")).toBe("");
    expect(extractSection("## [OTHER]\nfoo", "BUSINESS_CONTEXT")).toBe("");
  });

  it("handles the last section at the end of the document", () => {
    const raw = `## [BUSINESS_CONTEXT]\nfirst\n\n## [DECISION_RULES]\nlast section content\n`;
    expect(extractSection(raw, "DECISION_RULES")).toBe("last section content");
  });
});
