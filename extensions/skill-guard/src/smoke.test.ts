/**
 * Skill Guard end-to-end smoke test.
 *
 * Spins up the Python mock store server, creates test skill directories,
 * then runs the full CloudClient → HashCache → VerifyEngine pipeline
 * and validates all 11 acceptance criteria.
 */

import type { Skill } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ManifestResponse } from "./types.js";
import { AuditLogger } from "./audit-logger.js";
import { CloudClient } from "./cloud-client.js";
import { HashCache } from "./hash-cache.js";
import { VerifyEngine, listAllFiles } from "./verify-engine.js";

// ── helpers ────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(prefix = "sg-smoke-"): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeSkillFile(skillDir: string, relPath: string, content: string): string {
  const full = path.join(skillDir, ...relPath.split("/"));
  fsSync.mkdirSync(path.dirname(full), { recursive: true });
  fsSync.writeFileSync(full, content, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function makeSkill(name: string, baseDir: string): Skill {
  return { name, baseDir, filePath: path.join(baseDir, "SKILL.md") } as Skill;
}

// ── mock server management ─────────────────────────────────

let serverProcess: ChildProcess;
let serverPort: number;
let serverManifestPath: string;

const GOOD_SKILL_CONTENT = "# Good Skill\nA perfectly safe skill.";
const TAMPERED_CONTENT = "# Tampered\nevil payload injected";

beforeAll(async () => {
  // 1. Create test skill dirs + compute hashes
  const goodSkillDir = makeTmpDir("sg-good-");
  const goodHash = writeSkillFile(goodSkillDir, "SKILL.md", GOOD_SKILL_CONTENT);
  const goodScriptContent = "print('hello')";
  const goodScriptHash = writeSkillFile(goodSkillDir, "scripts/run.py", goodScriptContent);

  // 2. Build manifest JSON
  const manifest: ManifestResponse = {
    store: { name: "Smoke Test Store", version: "smoke-v1" },
    syncIntervalSeconds: 60,
    blocklist: ["evil-skill"],
    skills: {
      "good-skill": {
        version: "1.0.0",
        publisher: "tester",
        verified: true,
        fileCount: 2,
        files: {
          "SKILL.md": goodHash,
          "scripts/run.py": goodScriptHash,
        },
      },
    },
  };

  // Write manifest to temp file for the server
  const manifestDir = makeTmpDir("sg-manifest-");
  serverManifestPath = path.join(manifestDir, "manifest.json");
  fsSync.writeFileSync(serverManifestPath, JSON.stringify(manifest), "utf-8");

  // Store good-skill dir path for later use
  (globalThis as Record<string, unknown>).__sgGoodSkillDir = goodSkillDir;
  (globalThis as Record<string, unknown>).__sgManifest = manifest;

  // 3. Start the mock server
  const serverScript = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "../../../test/smoke/skill-guard-server.py",
  );

  serverProcess = spawn("python3", [serverScript], {
    env: {
      ...process.env,
      SKILL_GUARD_MANIFEST_JSON: serverManifestPath,
      SKILL_GUARD_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for startup JSON
  const portPromise = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10_000);
    let buffer = "";
    serverProcess.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes("\n")) {
        clearTimeout(timeout);
        try {
          const info = JSON.parse(buffer.trim());
          resolve(info.port as number);
        } catch (e) {
          reject(new Error(`bad startup JSON: ${buffer}`));
        }
      }
    });
    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  serverPort = await portPromise;
}, 15_000);

afterAll(async () => {
  // Kill the mock server
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => {
      serverProcess.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  // Clean up temp dirs
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── tests ──────────────────────────────────────────────────

describe("Skill Guard Smoke Test (E2E)", () => {
  // Helper: create a full pipeline connected to the mock server
  function createPipeline(
    sideloadPolicy: "warn" | "block-critical" | "block-all" = "block-critical",
    scanResult?: { critical: number; warn: number; detail: string },
  ) {
    const stateDir = makeTmpDir("sg-state-");
    const cachePath = path.join(stateDir, "cache.json");
    const auditPath = path.join(stateDir, "audit.jsonl");

    const cloud = new CloudClient({
      stores: [{ name: "Test", url: `http://127.0.0.1:${serverPort}/api/v1/skill-guard` }],
    });
    const cache = new HashCache(cachePath);
    const audit = new AuditLogger(auditPath);
    audit.init();

    const engine = new VerifyEngine({
      cache,
      audit,
      sideloadPolicy,
      scanDirSync: scanResult
        ? () => scanResult
        : () => ({ critical: 0, warn: 0, detail: "clean" }),
    });

    return { cloud, cache, audit, engine, auditPath };
  }

  it("E2E: fetches manifest from mock server and verifies good skill", async () => {
    const { cloud, cache, engine, audit } = createPipeline();

    // Sync manifest from mock server
    const manifest = await cloud.fetchManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.store.name).toBe("Smoke Test Store");
    cache.update(manifest!);

    // Verify good skill
    const goodDir = (globalThis as Record<string, unknown>).__sgGoodSkillDir as string;
    const skills = new Map<string, Skill>();
    skills.set("good-skill", makeSkill("good-skill", goodDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);

    audit.close();
  });

  it("E2E: 304 Not Modified when version matches", async () => {
    const { cloud } = createPipeline();
    const manifest = await cloud.fetchManifest();
    expect(manifest).not.toBeNull();

    // Second request with cached version
    const second = await cloud.fetchManifest(manifest!.store.version);
    expect(second).toBeNull(); // 304
  });

  it("E2E: blocklisted skill is blocked", async () => {
    const { cloud, cache, engine, audit } = createPipeline();
    cache.update((await cloud.fetchManifest())!);

    const evilDir = makeTmpDir("sg-evil-");
    writeSkillFile(evilDir, "SKILL.md", "# Evil");

    const skills = new Map<string, Skill>();
    skills.set("evil-skill", makeSkill("evil-skill", evilDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("evil-skill");

    audit.close();
  });

  it("E2E: tampered store skill is blocked", async () => {
    const { cloud, cache, engine, audit } = createPipeline();
    cache.update((await cloud.fetchManifest())!);

    const tamperedDir = makeTmpDir("sg-tampered-");
    writeSkillFile(tamperedDir, "SKILL.md", TAMPERED_CONTENT);
    writeSkillFile(tamperedDir, "scripts/run.py", "print('hello')");

    const skills = new Map<string, Skill>();
    skills.set("good-skill", makeSkill("good-skill", tamperedDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("good-skill");

    audit.close();
  });

  it("E2E: injected file in store skill is blocked", async () => {
    const { cloud, cache, engine, audit } = createPipeline();
    cache.update((await cloud.fetchManifest())!);

    const injectedDir = makeTmpDir("sg-injected-");
    writeSkillFile(injectedDir, "SKILL.md", GOOD_SKILL_CONTENT);
    writeSkillFile(injectedDir, "scripts/run.py", "print('hello')");
    writeSkillFile(injectedDir, "payload.js", "require('child_process').exec('rm -rf /')");

    const skills = new Map<string, Skill>();
    skills.set("good-skill", makeSkill("good-skill", injectedDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("good-skill");

    audit.close();
  });

  it("E2E: sideloaded skill passes when clean", async () => {
    const { cloud, cache, engine, audit } = createPipeline("block-critical", {
      critical: 0,
      warn: 0,
      detail: "clean",
    });
    cache.update((await cloud.fetchManifest())!);

    const sideloadDir = makeTmpDir("sg-sideload-");
    writeSkillFile(sideloadDir, "SKILL.md", "# My Custom Tool");

    const skills = new Map<string, Skill>();
    skills.set("my-custom-tool", makeSkill("my-custom-tool", sideloadDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);

    audit.close();
  });

  it("E2E: sideloaded with critical + block-critical → blocked", async () => {
    const { cloud, cache, engine, audit } = createPipeline("block-critical", {
      critical: 1,
      warn: 0,
      detail: "dangerous-exec in run.js",
    });
    cache.update((await cloud.fetchManifest())!);

    const badDir = makeTmpDir("sg-badsideload-");
    writeSkillFile(badDir, "SKILL.md", "# Bad Sideload");

    const skills = new Map<string, Skill>();
    skills.set("bad-sideload", makeSkill("bad-sideload", badDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("bad-sideload");

    audit.close();
  });

  it("E2E: sideloaded with critical + warn policy → warning only", async () => {
    const { cloud, cache, engine, audit } = createPipeline("warn", {
      critical: 1,
      warn: 0,
      detail: "dangerous-exec in run.js",
    });
    cache.update((await cloud.fetchManifest())!);

    const riskyDir = makeTmpDir("sg-riskysideload-");
    writeSkillFile(riskyDir, "SKILL.md", "# Risky");

    const skills = new Map<string, Skill>();
    skills.set("risky-sideload", makeSkill("risky-sideload", riskyDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);
    expect(verdict.warnings?.some((w) => w.name === "risky-sideload")).toBe(true);

    audit.close();
  });

  it("E2E: cloud unreachable + cached manifest → uses cache", async () => {
    // First, get a valid manifest and persist it
    const stateDir = makeTmpDir("sg-cache-test-");
    const cachePath = path.join(stateDir, "cache.json");
    const auditPath = path.join(stateDir, "audit.jsonl");

    const goodCloud = new CloudClient({
      stores: [{ url: `http://127.0.0.1:${serverPort}/api/v1/skill-guard` }],
    });
    const manifest = await goodCloud.fetchManifest();
    const cache1 = new HashCache(cachePath);
    cache1.update(manifest!);

    // Now create a client pointing to a dead server
    const deadCloud = new CloudClient({
      stores: [{ url: "http://127.0.0.1:1/api/v1/skill-guard" }],
      timeoutMs: 500,
    });

    // Load from disk cache
    const cache2 = new HashCache(cachePath);
    cache2.loadFromDisk();
    expect(cache2.hasData()).toBe(true);

    const audit = new AuditLogger(auditPath);
    audit.init();

    // Try cloud sync (will fail) — that's OK, we have cache
    try {
      await deadCloud.fetchManifest(cache2.getVersion());
    } catch {
      // expected
    }

    const engine = new VerifyEngine({
      cache: cache2,
      audit,
      sideloadPolicy: "block-critical",
    });

    // Verify a good skill using cached manifest
    const goodDir = (globalThis as Record<string, unknown>).__sgGoodSkillDir as string;
    const skills = new Map<string, Skill>();
    skills.set("good-skill", makeSkill("good-skill", goodDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);

    audit.close();
  });

  it("E2E: cloud unreachable + no cache → degrades to allow all", async () => {
    const stateDir = makeTmpDir("sg-nocache-");
    const cachePath = path.join(stateDir, "cache.json");
    const auditPath = path.join(stateDir, "audit.jsonl");

    const cache = new HashCache(cachePath);
    // Do NOT load or populate — no data
    expect(cache.hasData()).toBe(false);

    const audit = new AuditLogger(auditPath);
    audit.init();

    const engine = new VerifyEngine({
      cache,
      audit,
      sideloadPolicy: "block-critical",
    });

    const anyDir = makeTmpDir("sg-anyskill-");
    writeSkillFile(anyDir, "SKILL.md", "# Anything");

    const skills = new Map<string, Skill>();
    skills.set("anything", makeSkill("anything", anyDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toEqual([]);

    // Verify audit log has verification_off event
    audit.close();
    const logContent = fsSync.readFileSync(auditPath, "utf-8");
    expect(logContent).toContain("verification_off");
  });

  it("E2E: performance — 100 skills verified in < 500ms", async () => {
    const { cloud, cache, engine, audit } = createPipeline();

    // Build a big manifest with 100 skills
    const bigManifest: ManifestResponse = {
      store: { name: "Perf Test", version: "perf-v1" },
      syncIntervalSeconds: 60,
      blocklist: [],
      skills: {},
    };

    const skills = new Map<string, Skill>();

    for (let i = 0; i < 100; i++) {
      const skillName = `perf-skill-${i}`;
      const skillDir = makeTmpDir(`sg-perf-${i}-`);
      const hashes: Record<string, string> = {};

      // Each skill has 5 files
      for (let f = 0; f < 5; f++) {
        const relPath = f === 0 ? "SKILL.md" : `file-${f}.txt`;
        const content = `content-${skillName}-${f}-${Date.now()}`;
        const hash = writeSkillFile(skillDir, relPath, content);
        hashes[relPath] = hash;
      }

      bigManifest.skills[skillName] = {
        version: "1.0.0",
        fileCount: 5,
        files: hashes,
      };

      skills.set(skillName, makeSkill(skillName, skillDir));
    }

    cache.update(bigManifest);

    const start = performance.now();
    const verdict = engine.evaluate(skills);
    const elapsed = performance.now() - start;

    expect(verdict.blocked).toEqual([]);
    expect(elapsed).toBeLessThan(500);

    audit.close();
  });

  it("E2E: audit log captures correct events", async () => {
    const { cloud, cache, engine, audit, auditPath } = createPipeline("block-critical", {
      critical: 1,
      warn: 0,
      detail: "dangerous-exec",
    });
    cache.update((await cloud.fetchManifest())!);

    const goodDir = (globalThis as Record<string, unknown>).__sgGoodSkillDir as string;

    const evilDir = makeTmpDir("sg-evil2-");
    writeSkillFile(evilDir, "SKILL.md", "# Evil 2");

    const sideloadDir = makeTmpDir("sg-sideload2-");
    writeSkillFile(sideloadDir, "SKILL.md", "# Sideload");

    const skills = new Map<string, Skill>();
    skills.set("good-skill", makeSkill("good-skill", goodDir));
    skills.set("evil-skill", makeSkill("evil-skill", evilDir));
    skills.set("sideloaded", makeSkill("sideloaded", sideloadDir));

    const verdict = engine.evaluate(skills);
    expect(verdict.blocked).toContain("evil-skill");
    expect(verdict.blocked).toContain("sideloaded");
    expect(verdict.blocked).not.toContain("good-skill");

    audit.close();

    // Parse audit log
    const lines = fsSync.readFileSync(auditPath, "utf-8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l));

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("load_pass");
    expect(eventTypes).toContain("blocked");
    expect(events.some((e) => e.event === "blocked" && e.skill === "evil-skill")).toBe(true);
    expect(events.some((e) => e.event === "load_pass" && e.skill === "good-skill")).toBe(true);
  });
});
