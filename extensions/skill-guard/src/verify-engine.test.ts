import type { Skill } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManifestResponse } from "./types.js";
import { AuditLogger } from "./audit-logger.js";
import { HashCache } from "./hash-cache.js";
import { VerifyEngine, listAllFiles, sha256File } from "./verify-engine.js";

// ── helpers ────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "sg-ve-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

function writeFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, ...relPath.split("/"));
  fsSync.mkdirSync(path.dirname(full), { recursive: true });
  fsSync.writeFileSync(full, content, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function makeSkill(name: string, baseDir: string): Skill {
  return {
    name,
    baseDir,
    filePath: path.join(baseDir, "SKILL.md"),
  } as Skill;
}

function buildManifest(
  skills: Record<string, { fileCount: number; files: Record<string, string> }>,
  blocklist: string[] = [],
): ManifestResponse {
  const manifestSkills: ManifestResponse["skills"] = {};
  for (const [name, s] of Object.entries(skills)) {
    manifestSkills[name] = { version: "1.0.0", fileCount: s.fileCount, files: s.files };
  }
  return {
    store: { name: "Test", version: "v1" },
    syncIntervalSeconds: 60,
    blocklist,
    skills: manifestSkills,
  };
}

function createEngine(
  cacheDir: string,
  manifest: ManifestResponse | null,
  sideloadPolicy: "warn" | "block-critical" | "block-all" = "block-critical",
  scanResult?: { critical: number; warn: number; detail: string },
) {
  const cache = new HashCache(path.join(cacheDir, "cache.json"));
  if (manifest) cache.update(manifest);

  const auditPath = path.join(cacheDir, "audit.jsonl");
  const audit = new AuditLogger(auditPath);
  audit.init();

  const engine = new VerifyEngine({
    cache,
    audit,
    sideloadPolicy,
    scanDirSync: scanResult ? () => scanResult : () => ({ critical: 0, warn: 0, detail: "clean" }),
  });

  return { engine, audit, auditPath };
}

// ── tests ──────────────────────────────────────────────────

describe("VerifyEngine", () => {
  // Acceptance #1: guard.enabled=false → all load (handled by index.ts, but verify no-manifest case)
  it("acceptance #10: no manifest → degrades to allow all", () => {
    const cacheDir = makeTmpDir();
    const { engine } = createEngine(cacheDir, null);

    const skillDir = makeTmpDir();
    writeFile(skillDir, "SKILL.md", "# Test");

    const skills = new Map<string, Skill>();
    skills.set("any-skill", makeSkill("any-skill", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);
  });

  // Acceptance #2: store skill hash matches → pass
  it("acceptance #2: store skill with matching hashes passes", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    const hash = writeFile(skillDir, "SKILL.md", "# Good Skill");

    const manifest = buildManifest({
      "good-skill": { fileCount: 1, files: { "SKILL.md": hash } },
    });
    const { engine } = createEngine(cacheDir, manifest);

    const skills = new Map<string, Skill>();
    skills.set("good-skill", makeSkill("good-skill", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);
  });

  // Acceptance #3: store skill file tampered → blocked
  it("acceptance #3: store skill with tampered file is blocked", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    writeFile(skillDir, "SKILL.md", "# Tampered Content");

    const manifest = buildManifest({
      "tampered-skill": { fileCount: 1, files: { "SKILL.md": "0".repeat(64) } },
    });
    const { engine } = createEngine(cacheDir, manifest);

    const skills = new Map<string, Skill>();
    skills.set("tampered-skill", makeSkill("tampered-skill", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("tampered-skill");
  });

  // Acceptance #4: store skill with injected file → blocked
  it("acceptance #4: store skill with injected file is blocked", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    const hash = writeFile(skillDir, "SKILL.md", "# Good Skill");
    writeFile(skillDir, "payload.js", "evil()");

    const manifest = buildManifest({
      "injected-skill": { fileCount: 1, files: { "SKILL.md": hash } },
    });
    const { engine } = createEngine(cacheDir, manifest);

    const skills = new Map<string, Skill>();
    skills.set("injected-skill", makeSkill("injected-skill", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("injected-skill");
  });

  // Acceptance #5: blocklisted skill → blocked
  it("acceptance #5: blocklisted skill is blocked", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    writeFile(skillDir, "SKILL.md", "# Evil Skill");

    const manifest = buildManifest({}, ["evil-skill"]);
    const { engine } = createEngine(cacheDir, manifest);

    const skills = new Map<string, Skill>();
    skills.set("evil-skill", makeSkill("evil-skill", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("evil-skill");
  });

  // Acceptance #6: sideloaded skill no critical → pass
  it("acceptance #6: sideloaded skill with no critical findings passes", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    writeFile(skillDir, "SKILL.md", "# Custom");

    const manifest = buildManifest({}); // skill not in store
    const { engine } = createEngine(cacheDir, manifest, "block-critical", {
      critical: 0,
      warn: 1,
      detail: "suspicious-network in script.js",
    });

    const skills = new Map<string, Skill>();
    skills.set("custom-tool", makeSkill("custom-tool", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);
  });

  // Acceptance #7: sideloaded + critical + block-critical → blocked
  it("acceptance #7: sideloaded skill with critical + block-critical is blocked", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    writeFile(skillDir, "SKILL.md", "# Bad Sideload");

    const manifest = buildManifest({});
    const { engine } = createEngine(cacheDir, manifest, "block-critical", {
      critical: 2,
      warn: 0,
      detail: "dangerous-exec in run.js, env-harvesting in collect.js",
    });

    const skills = new Map<string, Skill>();
    skills.set("bad-sideload", makeSkill("bad-sideload", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("bad-sideload");
  });

  // Acceptance #8: sideloaded + critical + warn policy → warn only
  it("acceptance #8: sideloaded skill with critical + warn policy gives warning only", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    writeFile(skillDir, "SKILL.md", "# Risky Sideload");

    const manifest = buildManifest({});
    const { engine } = createEngine(cacheDir, manifest, "warn", {
      critical: 1,
      warn: 0,
      detail: "dangerous-exec in run.js",
    });

    const skills = new Map<string, Skill>();
    skills.set("risky-sideload", makeSkill("risky-sideload", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);
    expect(verdict.warnings?.some((w) => w.name === "risky-sideload")).toBe(true);
  });

  // Acceptance #9: cloud unreachable + has cache → uses cache (tested via cache preload)
  it("acceptance #9: uses cached manifest when available", () => {
    const cacheDir = makeTmpDir();
    const skillDir = makeTmpDir();
    const hash = writeFile(skillDir, "SKILL.md", "# Cached");

    const manifest = buildManifest({
      "cached-skill": { fileCount: 1, files: { "SKILL.md": hash } },
    });
    // Simulate: write to cache, then create engine that loads from disk
    const cache = new HashCache(path.join(cacheDir, "cache.json"));
    cache.update(manifest);

    const cache2 = new HashCache(path.join(cacheDir, "cache.json"));
    cache2.loadFromDisk();
    expect(cache2.hasData()).toBe(true);

    const audit = new AuditLogger(path.join(cacheDir, "audit.jsonl"));
    audit.init();
    const engine = new VerifyEngine({
      cache: cache2,
      audit,
      sideloadPolicy: "block-critical",
    });

    const skills = new Map<string, Skill>();
    skills.set("cached-skill", makeSkill("cached-skill", skillDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);
    audit.close();
  });
});

describe("listAllFiles", () => {
  it("lists all files recursively with forward-slash paths", () => {
    const dir = makeTmpDir();
    writeFile(dir, "SKILL.md", "# Test");
    writeFile(dir, "scripts/run.py", "print('hi')");
    writeFile(dir, "src/main.js", "export default 1;");

    const files = listAllFiles(dir);
    expect(files).toContain("SKILL.md");
    expect(files).toContain("scripts/run.py");
    expect(files).toContain("src/main.js");
    expect(files).toHaveLength(3);
  });

  it("skips hidden files and node_modules", () => {
    const dir = makeTmpDir();
    writeFile(dir, "SKILL.md", "# Test");
    writeFile(dir, ".hidden/secret.js", "evil");
    writeFile(dir, "node_modules/pkg/index.js", "ok");

    const files = listAllFiles(dir);
    expect(files).toEqual(["SKILL.md"]);
  });
});

describe("sha256File", () => {
  it("computes correct sha256 hex", () => {
    const dir = makeTmpDir();
    const content = "hello world";
    writeFile(dir, "test.txt", content);
    const expected = crypto.createHash("sha256").update(content).digest("hex");
    expect(sha256File(path.join(dir, "test.txt"))).toBe(expected);
  });
});
