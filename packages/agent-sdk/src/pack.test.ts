// @openclaw/agent-sdk — Unit tests for PR 1: schema + integrity + pack + validate.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

const PKG_DIST = resolve(import.meta.dirname, "..", "dist");
const FIXTURES = resolve(import.meta.dirname, "__fixtures__");
const VALID_PACK = resolve(FIXTURES, "valid-pack");
const TMP = resolve(FIXTURES, "tmp");

// ── hash utility ────────────────────────────────────────────────────

describe("hash", () => {
  it("produces sha256: prefixed hex for a string", async () => {
    const { hashString } = await import(`${PKG_DIST}/hash.mjs`);
    const h = hashString("hello");
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("produces different hashes for different inputs", async () => {
    const { hashString } = await import(`${PKG_DIST}/hash.mjs`);
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("produces the same hash for the same input", async () => {
    const { hashString } = await import(`${PKG_DIST}/hash.mjs`);
    expect(hashString("stable")).toBe(hashString("stable"));
  });

  it("hashes a file", async () => {
    const { hashFile } = await import(`${PKG_DIST}/hash.mjs`);
    const h = hashFile(resolve(VALID_PACK, "files/AGENTS.md"));
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ── pack command (uses CLI subprocess) ─────────────────────────────

describe("pack", () => {
  beforeAll(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  });

  it("generates openclaw.integrity.json from a valid package", () => {
    // Run pack via tsx from the package root so imports resolve
    const result = execSync(`npx tsx src/cli.ts pack ${VALID_PACK}`, {
      encoding: "utf8",
      cwd: resolve(import.meta.dirname, ".."),
    });
    expect(result).toContain("Integrity manifest written");
    expect(result).toContain("Files tracked: 4");
    expect(result).toContain("Skills tracked: 1");

    const integrityPath = resolve(VALID_PACK, "openclaw.integrity.json");
    expect(existsSync(integrityPath)).toBe(true);

    const integrity = JSON.parse(readFileSync(integrityPath, "utf8"));
    expect(integrity.version).toBe(1);
    expect(integrity.algorithm).toBe("sha256");
    expect(integrity.package.name).toBe("test-agent");
    expect(integrity.package.version).toBe("1.0.0");
    expect(Object.keys(integrity.files)).toHaveLength(4);
    expect(Object.keys(integrity.skills)).toHaveLength(1);
  });

  it("fails when agent-package.json is missing", () => {
    const emptyDir = resolve(TMP, "no-manifest");
    if (!existsSync(emptyDir)) mkdirSync(emptyDir, { recursive: true });

    let threw = false;
    try {
      execSync(`npx tsx src/cli.ts pack ${emptyDir}`, {
        encoding: "utf8",
        cwd: resolve(import.meta.dirname, ".."),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("fails when a required field is missing", () => {
    const badDir = resolve(TMP, "bad-manifest");
    if (!existsSync(badDir)) mkdirSync(badDir, { recursive: true });
    writeFileSync(
      resolve(badDir, "agent-package.json"),
      JSON.stringify({
        name: "bad",
        description: "missing version and files",
      }),
      "utf8",
    );

    let threw = false;
    let stderr = "";
    try {
      execSync(`npx tsx src/cli.ts pack ${badDir}`, {
        encoding: "utf8",
        cwd: resolve(import.meta.dirname, ".."),
      });
    } catch (e) {
      threw = true;
      stderr = (e as { stderr: Buffer }).stderr.toString();
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("version is required");
  });

  it("fails when a copy src file is missing", () => {
    const missingSrcDir = resolve(TMP, "missing-src");
    if (!existsSync(missingSrcDir)) mkdirSync(missingSrcDir, { recursive: true });
    mkdirSync(resolve(missingSrcDir, "files"), { recursive: true });
    writeFileSync(
      resolve(missingSrcDir, "agent-package.json"),
      JSON.stringify({
        name: "missing-src",
        version: "1.0.0",
        description: "Missing source file.",
        files: {
          copy: [{ src: "files/AGENTS.md", dest: "AGENTS.md" }],
          mutable: [],
        },
      }),
      "utf8",
    );

    let threw = false;
    let stderr = "";
    try {
      execSync(`npx tsx src/cli.ts pack ${missingSrcDir}`, {
        encoding: "utf8",
        cwd: resolve(import.meta.dirname, ".."),
      });
    } catch (e) {
      threw = true;
      stderr = (e as { stderr: Buffer }).stderr.toString();
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("src not found");
  });
});

// ── validate command (uses runValidation from dist) ────────────────

describe("validate", () => {
  let validIntegrity: string;

  beforeAll(() => {
    validIntegrity = readFileSync(resolve(VALID_PACK, "openclaw.integrity.json"), "utf8");
  });

  it("passes for a valid package with matching integrity", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const { result } = runValidation(VALID_PACK);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when agent-package.json is missing", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const emptyDir = resolve(TMP, "no-manifest-validate");
    if (!existsSync(emptyDir)) mkdirSync(emptyDir, { recursive: true });

    const { result } = runValidation(emptyDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("not found"))).toBe(true);
  });

  it("fails when manifest has schema errors", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const badDir = resolve(TMP, "validate-bad-schema");
    if (!existsSync(badDir)) mkdirSync(badDir, { recursive: true });
    writeFileSync(
      resolve(badDir, "agent-package.json"),
      JSON.stringify({
        name: "",
        version: "not-semver",
        files: {
          copy: [],
          mutable: [],
        },
      }),
      "utf8",
    );

    const { result } = runValidation(badDir);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when a consumer has no mapping", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const noMappingDir = resolve(TMP, "no-mapping");
    if (!existsSync(noMappingDir)) mkdirSync(noMappingDir, { recursive: true });
    writeFileSync(
      resolve(noMappingDir, "agent-package.json"),
      JSON.stringify({
        name: "no-mapping",
        version: "1.0.0",
        description: "Missing secret mapping.",
        files: {
          copy: [],
          mutable: [],
        },
        secrets: {
          consumer: [{ name: "API_KEY", required: true }],
          mapping: {},
        },
      }),
      "utf8",
    );

    const { result } = runValidation(noMappingDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("missing for consumer"))).toBe(true);
  });

  it("fails when integrity mismatch (file changed after pack)", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const tamperDir = resolve(TMP, "tampered");
    if (!existsSync(tamperDir)) mkdirSync(tamperDir, { recursive: true });
    mkdirSync(resolve(tamperDir, "files"), { recursive: true });
    writeFileSync(resolve(tamperDir, "files/AGENTS.md"), "tampered content", "utf8");
    writeFileSync(
      resolve(tamperDir, "agent-package.json"),
      JSON.stringify({
        name: "tampered",
        version: "1.0.0",
        description: "Tampered file test.",
        files: {
          copy: [{ src: "files/AGENTS.md", dest: "AGENTS.md" }],
          mutable: [],
        },
      }),
      "utf8",
    );
    writeFileSync(resolve(tamperDir, "openclaw.integrity.json"), validIntegrity, "utf8");

    const { result } = runValidation(tamperDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("integrity mismatch"))).toBe(true);
  });

  it("fails when mutable path contains instruction file", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const badMutableDir = resolve(TMP, "bad-mutable");
    if (!existsSync(badMutableDir)) mkdirSync(badMutableDir, { recursive: true });
    writeFileSync(
      resolve(badMutableDir, "agent-package.json"),
      JSON.stringify({
        name: "bad-mutable",
        version: "1.0.0",
        description: "Mutable overlaps instruction file.",
        files: {
          copy: [],
          mutable: [{ dest: "AGENTS.md", description: "Should fail." }],
        },
        policy: {
          denyMutableInstructionFiles: true,
        },
      }),
      "utf8",
    );

    const { result } = runValidation(badMutableDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("denyMutableInstructionFiles"))).toBe(true);
  });

  it("fails when mutable path overlaps a copied file dest", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const overlapDir = resolve(TMP, "overlap");
    if (!existsSync(overlapDir)) mkdirSync(overlapDir, { recursive: true });
    writeFileSync(
      resolve(overlapDir, "agent-package.json"),
      JSON.stringify({
        name: "overlap",
        version: "1.0.0",
        description: "Mutable overlaps copy dest.",
        files: {
          copy: [{ src: "files/test.md", dest: "test.md" }],
          mutable: [{ dest: "test.md", description: "Should fail." }],
        },
      }),
      "utf8",
    );

    const { result } = runValidation(overlapDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("overlaps with copied file"))).toBe(true);
  });

  it("warns when integrity manifest is missing but schema is valid", async () => {
    const { runValidation } = await import(`${PKG_DIST}/commands/validate.mjs`);
    const noIntegDir = resolve(TMP, "no-integrity");
    if (!existsSync(noIntegDir)) mkdirSync(noIntegDir, { recursive: true });
    writeFileSync(
      resolve(noIntegDir, "agent-package.json"),
      JSON.stringify({
        name: "no-integrity",
        version: "1.0.0",
        description: "No integrity manifest.",
        files: {
          copy: [],
          mutable: [],
        },
      }),
      "utf8",
    );

    const { result } = runValidation(noIntegDir);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.message.includes("not found"))).toBe(true);
  });
});
