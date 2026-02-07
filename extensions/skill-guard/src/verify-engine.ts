/**
 * Skill Guard verification engine.
 *
 * Evaluates every loaded skill against the cloud manifest:
 * - Store skills: blocklist → fileCount → extra/missing files → SHA256
 * - Sideloaded skills: local static scan via skill-scanner
 *
 * All operations are **synchronous** because `loadSkillEntries()` is sync.
 */

import type { Skill } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SkillLoadGuardVerdict } from "../../../src/agents/skills/load-guard.js";
import type { SkillGuardSideloadPolicy } from "../../../src/config/types.skills.js";
import type { AuditLogger } from "./audit-logger.js";
import type { HashCache } from "./hash-cache.js";
import type { ManifestSkill } from "./types.js";

export type VerifyEngineOptions = {
  cache: HashCache;
  audit: AuditLogger;
  sideloadPolicy: SkillGuardSideloadPolicy;
  /** External scan function (injected so we can test without importing the real scanner). */
  scanDirSync?: (baseDir: string) => { critical: number; warn: number; detail: string };
};

type SingleVerdict = { verdict: "pass" | "blocked" | "warn"; reason: string };

export class VerifyEngine {
  private cache: HashCache;
  private audit: AuditLogger;
  private sideloadPolicy: SkillGuardSideloadPolicy;
  private scanDirSync: (baseDir: string) => { critical: number; warn: number; detail: string };

  constructor(opts: VerifyEngineOptions) {
    this.cache = opts.cache;
    this.audit = opts.audit;
    this.sideloadPolicy = opts.sideloadPolicy;
    this.scanDirSync = opts.scanDirSync ?? defaultScanSync;
  }

  /** Main entry point — synchronous evaluation of all skills. */
  evaluate(skills: Map<string, Skill>): SkillLoadGuardVerdict {
    const blocked: string[] = [];
    const warnings: Array<{ name: string; message: string }> = [];

    if (!this.cache.hasData()) {
      this.audit.record({ event: "verification_off", detail: "no manifest available" });
      return { blocked, warnings };
    }

    const manifest = this.cache.getManifest()!;
    const blocklist = new Set(manifest.blocklist);

    for (const [name, skill] of skills) {
      const result = this.verifySingle(name, skill, blocklist, manifest.skills[name]);

      if (result.verdict === "blocked") {
        blocked.push(name);
        this.audit.record({ event: "blocked", skill: name, reason: result.reason });
      } else if (result.verdict === "warn") {
        warnings.push({ name, message: result.reason });
        this.audit.record({ event: "sideload_warn", skill: name, reason: result.reason });
      } else {
        const source = manifest.skills[name] ? "store" : "sideload";
        this.audit.record({
          event: source === "store" ? "load_pass" : "sideload_pass",
          skill: name,
          source,
        });
      }
    }

    return { blocked, warnings };
  }

  // ── private ──────────────────────────────────────────────

  private verifySingle(
    name: string,
    skill: Skill,
    blocklist: Set<string>,
    storeSkill: ManifestSkill | undefined,
  ): SingleVerdict {
    // Step 1: Blocklist
    if (blocklist.has(name)) {
      return { verdict: "blocked", reason: "blocklisted" };
    }

    // Step 2: Store existence check
    if (!storeSkill) {
      return this.handleSideload(name, skill);
    }

    // Step 3-6: Full directory verification for store skills
    return this.verifyStoreSkill(skill, storeSkill);
  }

  private handleSideload(name: string, skill: Skill): SingleVerdict {
    this.audit.record({ event: "not_in_store", skill: name });

    if (this.sideloadPolicy === "warn") {
      // Scan but never block
      const scan = this.scanDirSync(skill.baseDir);
      if (scan.critical > 0) {
        return { verdict: "warn", reason: `sideload scan: ${scan.detail}` };
      }
      return { verdict: "pass", reason: "sideload allowed" };
    }

    // block-critical or block-all
    const scan = this.scanDirSync(skill.baseDir);

    if (this.sideloadPolicy === "block-all" && (scan.critical > 0 || scan.warn > 0)) {
      return { verdict: "blocked", reason: `sideload scan (block-all): ${scan.detail}` };
    }
    if (this.sideloadPolicy === "block-critical" && scan.critical > 0) {
      return { verdict: "blocked", reason: `sideload scan: ${scan.detail}` };
    }

    return { verdict: "pass", reason: "sideload allowed" };
  }

  private verifyStoreSkill(skill: Skill, expected: ManifestSkill): SingleVerdict {
    const baseDir = skill.baseDir;

    // Step 3: File count fast path
    const actualFiles = listAllFiles(baseDir);
    if (actualFiles.length !== expected.fileCount) {
      return {
        verdict: "blocked",
        reason: `file count: expected ${expected.fileCount}, found ${actualFiles.length}`,
      };
    }

    // Step 4: Extra files (injection detection)
    const expectedSet = new Set(Object.keys(expected.files));
    for (const file of actualFiles) {
      if (!expectedSet.has(file)) {
        return { verdict: "blocked", reason: `unexpected file: ${file}` };
      }
    }

    // Step 5: Missing files
    const actualSet = new Set(actualFiles);
    for (const file of expectedSet) {
      if (!actualSet.has(file)) {
        return { verdict: "blocked", reason: `missing file: ${file}` };
      }
    }

    // Step 6: Per-file SHA256
    for (const [relPath, expectedHash] of Object.entries(expected.files)) {
      const fullPath = path.join(baseDir, ...relPath.split("/"));
      try {
        const content = fs.readFileSync(fullPath);
        const actual = crypto.createHash("sha256").update(content).digest("hex");
        if (actual !== expectedHash) {
          return { verdict: "blocked", reason: `hash mismatch: ${relPath}` };
        }
      } catch {
        return { verdict: "blocked", reason: `file unreadable: ${relPath}` };
      }
    }

    return { verdict: "pass", reason: "store verified" };
  }
}

// ── utility functions ──────────────────────────────────────

/**
 * Recursively list all files under `baseDir`, returning forward-slash
 * relative paths.  Skips hidden files/dirs and node_modules.
 */
export function listAllFiles(baseDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, full).split(path.sep).join("/");
        results.push(rel);
      }
    }
  };
  walk(baseDir);
  return results.sort();
}

/** Compute SHA256 hex digest of a file. */
export function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Default synchronous scan stub.
 * In production, the Extension index wires this to the real skill-scanner.
 */
function defaultScanSync(_baseDir: string): { critical: number; warn: number; detail: string } {
  return { critical: 0, warn: 0, detail: "no scanner available" };
}
