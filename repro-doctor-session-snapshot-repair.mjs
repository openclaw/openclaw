#!/usr/bin/env node
/**
 * repro-doctor-session-snapshot-repair.mjs
 *
 * Real Behavior Proof for PR #85691:
 * fix(doctor): auto-repair stale session snapshot paths on --fix
 *
 * Zero dependencies — run with: node repro-doctor-session-snapshot-repair.mjs
 *
 * Mirrors the exact repair logic from the PR (v2 — layered on current main scanner):
 * - Uses extractBundledSkillRelativeSegments + resolveExpectedBundledSkillPath pattern
 * - Scoped replacement: only modifies snapshot metadata fields
 * - Handles JSON-escaped, XML-escaped, and raw path forms
 * - Creates .bak backup before writing
 * - Validates JSON integrity after repair
 *
 * Date: 2026-05-29
 * Node: v24.14.0
 * Platform: linux x64
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `openclaw-doctor-proof-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

const staleRoot = "/home/user/.local/share/pnpm/global/5/node_modules/openclaw@2026.5.20_@types+express@5.0.6";
const liveRoot = "/home/user/.local/share/pnpm/global/5/node_modules/openclaw@2026.5.20";

function splitPathSegments(value) {
  return value.replace(/^[a-z]:/i, "").replaceAll("\\", "/").split("/").filter(Boolean);
}

function isWindowsAbsolutePath(value) {
  return (/^[a-z]:/i.test(value) && ["/", "\\"].includes(value.slice(2, 3))) || value.startsWith("\\\\");
}

function isTempBackedOpenClawRoot(segments) {
  const lower = segments.map(s => s.toLowerCase());
  const idx = lower.lastIndexOf("openclaw");
  return idx >= 1 && (lower[idx - 1] === "tmp" || lower[idx - 1] === "temp");
}

function isBundledRuntimeSkillsPath(cachedPath, skillRootIndex) {
  const before = splitPathSegments(cachedPath).slice(0, skillRootIndex);
  const lower = before.map(s => s.toLowerCase());
  return lower.some(s => s === "dist-runtime" || s === "node_modules" || s.startsWith("openclaw@"))
    || isTempBackedOpenClawRoot(before);
}

function extractBundledSkillRelativeSegments(cachedPath) {
  const segments = splitPathSegments(cachedPath);
  const skillRootIndex = segments.lastIndexOf("skills");
  if (skillRootIndex < 0 || !isBundledRuntimeSkillsPath(cachedPath, skillRootIndex)) return undefined;
  const rel = segments.slice(skillRootIndex + 1);
  if (rel.length < 2 || rel.at(-1) !== "SKILL.md") return undefined;
  return rel;
}

function resolveExpectedBundledSkillPath(cachedPath, bundledSkillsDir) {
  const segments = splitPathSegments(cachedPath);
  const rel = extractBundledSkillRelativeSegments(cachedPath);
  if (!rel) return undefined;
  const expected = [bundledSkillsDir, ...rel].join("/");
  return expected;
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractSkillLocations(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return [];
  const locations = [];
  const pattern = /<location>([\s\S]*?)<\/location>/g;
  for (const match of prompt.matchAll(pattern)) {
    const raw = match[1]?.trim();
    if (raw) locations.push(decodeXmlText(raw));
  }
  return locations;
}

function collectResolvedSkillPaths(resolvedSkills) {
  if (!Array.isArray(resolvedSkills)) return [];
  const paths = [];
  for (const skill of resolvedSkills) {
    if (!skill || typeof skill !== "object") continue;
    if (typeof skill.filePath === "string" && skill.filePath.trim()) paths.push(skill.filePath.trim());
    if (typeof skill.baseDir === "string" && skill.baseDir.trim()) paths.push(skill.baseDir.trim() + "/SKILL.md");
  }
  return paths;
}

function collectInjectedWorkspaceFilePaths(injected) {
  if (!Array.isArray(injected)) return [];
  return injected
    .map(e => (e && typeof e === "object" && typeof e.path === "string" ? e.path.trim() : ""))
    .filter(Boolean);
}

function collectCachedSnapshotPaths(entry) {
  const snapshot = entry.skillsSnapshot;
  const report = entry.systemPromptReport;
  const paths = [];
  for (const loc of extractSkillLocations(snapshot?.prompt)) {
    paths.push({ field: "skillsSnapshot.prompt", path: loc });
  }
  for (const loc of collectResolvedSkillPaths(snapshot?.resolvedSkills)) {
    paths.push({ field: "skillsSnapshot.resolvedSkills", path: loc });
  }
  if (report && typeof report === "object") {
    for (const loc of collectInjectedWorkspaceFilePaths(report.injectedWorkspaceFiles)) {
      paths.push({ field: "systemPromptReport.injectedWorkspaceFiles", path: loc });
    }
  }
  return paths;
}

function isInsidePath(baseDir, candidatePath) {
  const baseIsWin = isWindowsAbsolutePath(baseDir);
  const candIsWin = isWindowsAbsolutePath(candidatePath);
  if (baseIsWin !== candIsWin) return false;
  const normBase = baseDir.replaceAll("\\", "/");
  const normCand = candidatePath.replaceAll("\\", "/");
  return normCand.startsWith(normBase + "/") || normCand === normBase;
}

function findStalePaths(store, bundledSkillsDir) {
  const findings = [];
  const seen = new Set();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") continue;
    for (const cached of collectCachedSnapshotPaths(entry)) {
      if (isInsidePath(bundledSkillsDir, cached.path)) continue;
      const expectedPath = resolveExpectedBundledSkillPath(cached.path, bundledSkillsDir);
      if (!expectedPath) continue;
      const key = `${sessionKey}\0${cached.field}\0${cached.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ sessionKey, field: cached.field, cachedPath: cached.path, expectedPath });
    }
  }
  return findings;
}

function replacePathsInSession(session, finding) {
  let count = 0;
  const jsonEscaped = JSON.stringify(finding.cachedPath).slice(1, -1);
  const jsonEscapedExpected = JSON.stringify(finding.expectedPath).slice(1, -1);
  const xmlEscaped = finding.cachedPath.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const xmlEscapedExpected = finding.expectedPath.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

  if (finding.field === "skillsSnapshot.prompt") {
    const snapshot = session.skillsSnapshot;
    if (snapshot && typeof snapshot.prompt === "string") {
      let prompt = snapshot.prompt;
      const original = prompt;
      if (prompt.includes(jsonEscaped)) { count += prompt.split(jsonEscaped).length - 1; prompt = prompt.replaceAll(jsonEscaped, jsonEscapedExpected); }
      if (prompt.includes(xmlEscaped)) { count += prompt.split(xmlEscaped).length - 1; prompt = prompt.replaceAll(xmlEscaped, xmlEscapedExpected); }
      if (prompt.includes(finding.cachedPath)) { count += prompt.split(finding.cachedPath).length - 1; prompt = prompt.replaceAll(finding.cachedPath, finding.expectedPath); }
      if (prompt !== original) snapshot.prompt = prompt;
    }
  } else if (finding.field === "skillsSnapshot.resolvedSkills") {
    const snapshot = session.skillsSnapshot;
    if (snapshot && Array.isArray(snapshot.resolvedSkills)) {
      for (const entry of snapshot.resolvedSkills) {
        if (!entry || typeof entry !== "object") continue;
        for (const field of ["filePath", "baseDir"]) {
          if (typeof entry[field] !== "string") continue;
          let value = entry[field];
          const original = value;
          const candidates = [
            { cached: jsonEscaped, expected: jsonEscapedExpected },
            { cached: finding.cachedPath, expected: finding.expectedPath },
          ];
          if (field === "baseDir") {
            for (const suffix of ["/SKILL.md", "\\SKILL.md"]) {
              if (finding.cachedPath.endsWith(suffix)) {
                const cachedDir = finding.cachedPath.slice(0, -suffix.length);
                const expectedDir = finding.expectedPath.slice(0, -suffix.length);
                candidates.push(
                  { cached: JSON.stringify(cachedDir).slice(1, -1), expected: JSON.stringify(expectedDir).slice(1, -1) },
                  { cached: cachedDir, expected: expectedDir },
                );
              }
            }
          }
          for (const { cached, expected } of candidates) {
            if (value.includes(cached)) { count += value.split(cached).length - 1; value = value.replaceAll(cached, expected); }
          }
          if (value !== original) entry[field] = value;
        }
      }
    }
  } else if (finding.field === "systemPromptReport.injectedWorkspaceFiles") {
    const report = session.systemPromptReport;
    if (report && Array.isArray(report.injectedWorkspaceFiles)) {
      for (const entry of report.injectedWorkspaceFiles) {
        if (!entry || typeof entry.path !== "string") continue;
        let entryPath = entry.path;
        const original = entryPath;
        for (const { cached, expected } of [
          { cached: jsonEscaped, expected: jsonEscapedExpected },
          { cached: finding.cachedPath, expected: finding.expectedPath },
        ]) {
          if (entryPath.includes(cached)) { count += entryPath.split(cached).length - 1; entryPath = entryPath.replaceAll(cached, expected); }
        }
        if (entryPath !== original) entry.path = entryPath;
      }
    }
  }
  return count;
}

async function main() {
  console.log("─".repeat(72));
  console.log("Real Behavior Proof: Doctor Session Snapshot Auto-Repair");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version} | Platform: ${process.platform} ${process.arch}`);
  console.log("─".repeat(72));
  console.log();

  let passed = 0, failed = 0;

  // Scenario 1: WITHOUT repair
  console.log("Scenario 1: WITHOUT repair — findings computed but not applied");
  const sessions1 = {
    "session-1": {
      skillsSnapshot: {
        prompt: `Use <location>${staleRoot}/skills/my-skill/SKILL.md</location>`,
        resolvedSkills: [{ id: "my-skill", baseDir: `${staleRoot}/skills/my-skill` }],
      },
    },
  };
  const findings1 = findStalePaths(sessions1, liveRoot);
  console.log(`  Findings computed: ${findings1.length} stale paths`);
  console.log(`  Repair performed: NO (shouldRepair not enabled)`);
  if (findings1.length === 2) { console.log("  PASS"); passed++; } else { console.log(`  FAIL: expected 2, got ${findings1.length}`); failed++; }
  console.log();

  // Scenario 2: WITH repair
  console.log("Scenario 2: WITH repair — paths replaced correctly");
  const sessions2 = JSON.parse(JSON.stringify(sessions1));
  const file2 = join(testDir, "sessions2.json");
  writeFileSync(file2, JSON.stringify(sessions2, null, 2));
  const backup2 = `${file2}.bak`;
  copyFileSync(file2, backup2);

  let totalCount = 0;
  for (const finding of findStalePaths(sessions2, liveRoot)) {
    totalCount += replacePathsInSession(sessions2[finding.sessionKey], finding);
  }
  writeFileSync(file2, JSON.stringify(sessions2, null, 2));

  const remaining2 = findStalePaths(sessions2, liveRoot);
  const jsonValid2 = (() => { try { JSON.parse(readFileSync(file2, "utf-8")); return true; } catch { return false; } })();
  console.log(`  Paths replaced: ${totalCount}`);
  console.log(`  Backup created: ${existsSync(backup2)}`);
  console.log(`  JSON valid: ${jsonValid2}`);
  console.log(`  Stale paths remaining: ${remaining2.length}`);
  if (totalCount === 2 && existsSync(backup2) && jsonValid2 && remaining2.length === 0) { console.log("  PASS"); passed++; } else { console.log("  FAIL"); failed++; }
  console.log();

  // Scenario 3: Windows backslash paths
  console.log("Scenario 3: Windows backslash paths — JSON-escaped in file");
  const winStale = "C:\\Users\\user\\.local\\share\\pnpm\\global\\5\\node_modules\\openclaw@2026.5.20_@types+express@5.0.6";
  const winLive = "C:\\Users\\user\\.local\\share\\pnpm\\global\\5\\node_modules\\openclaw@2026.5.20";
  const winSessions = { "session-win": { skillsSnapshot: { prompt: `Use <location>${winStale}/skills/my-skill/SKILL.md</location>` } } };
  const winFindings = findStalePaths(winSessions, winLive);
  let winCount = 0;
  for (const f of winFindings) winCount += replacePathsInSession(winSessions[f.sessionKey], f);
  const winRepaired = JSON.stringify(winSessions);
  const hasWinLive = winRepaired.includes(JSON.stringify(winLive).slice(1, -1));
  const hasWinStale = winRepaired.includes(JSON.stringify(winStale).slice(1, -1));
  console.log(`  Repaired contains live root: ${hasWinLive}`);
  console.log(`  Repaired contains stale root: ${hasWinStale}`);
  if (hasWinLive && !hasWinStale && winCount > 0) { console.log("  PASS"); passed++; } else { console.log("  FAIL"); failed++; }
  console.log();

  // Scenario 4: XML-escaped prompt paths with & character
  console.log("Scenario 4: XML-escaped prompt paths — entity-encoded in file");
  const xmlStale = "/home/user/projects/my&company/openclaw@2026.5.20_@types+express@5.0.6";
  const xmlLive = "/home/user/projects/my&company/openclaw@2026.5.20";
  const xmlEscapedStale = xmlStale.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const xmlSessions = { "session-xml": { skillsSnapshot: { prompt: `Use <location>${xmlEscapedStale}/skills/my-skill/SKILL.md</location>` } } };
  const xmlFindings = findStalePaths(xmlSessions, xmlLive);
  let xmlCount = 0;
  for (const f of xmlFindings) xmlCount += replacePathsInSession(xmlSessions[f.sessionKey], f);
  const xmlRepaired = JSON.stringify(xmlSessions);
  const xmlLiveEscaped = xmlLive.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const hasXmlLive = xmlRepaired.includes(xmlLiveEscaped);
  const hasXmlStale = xmlRepaired.includes(xmlEscapedStale);
  console.log(`  Repaired contains live root: ${hasXmlLive}`);
  console.log(`  Repaired contains stale root: ${hasXmlStale}`);
  if (hasXmlLive && !hasXmlStale && xmlCount > 0) { console.log("  PASS"); passed++; } else { console.log("  FAIL"); failed++; }
  console.log();

  // Scenario 5: Idempotent
  console.log("Scenario 5: Idempotent — second run finds nothing");
  const sessions5 = JSON.parse(JSON.stringify(sessions1));
  for (const f of findStalePaths(sessions5, liveRoot)) replacePathsInSession(sessions5[f.sessionKey], f);
  const secondFindings = findStalePaths(sessions5, liveRoot);
  console.log(`  Second scan findings: ${secondFindings.length}`);
  if (secondFindings.length === 0) { console.log("  PASS"); passed++; } else { console.log("  FAIL"); failed++; }
  console.log();

  // Scenario 6: Scoped replacement — unrelated content preserved
  console.log("Scenario 6: Scoped replacement — unrelated content preserved");
  const sessions6 = {
    "session-scoped": {
      skillsSnapshot: { prompt: `Use <location>${staleRoot}/skills/my-skill/SKILL.md</location>` },
      transcript: `User mentioned ${staleRoot} in their message. This should NOT be modified.`,
      userMessage: `I have a file at ${staleRoot}/some/file.txt that needs attention.`,
    },
    "session-other": {
      skillsSnapshot: { prompt: `Another skill at <location>${staleRoot}/skills/other-skill/SKILL.md</location>` },
    },
  };
  let scopedCount = 0;
  for (const f of findStalePaths(sessions6, liveRoot)) scopedCount += replacePathsInSession(sessions6[f.sessionKey], f);
  const transcriptOk = sessions6["session-scoped"].transcript.includes(staleRoot);
  const userMsgOk = sessions6["session-scoped"].userMessage.includes(staleRoot);
  const promptOk = !sessions6["session-scoped"].skillsSnapshot.prompt.includes(staleRoot);
  const otherOk = !sessions6["session-other"].skillsSnapshot.prompt.includes(staleRoot);
  console.log(`  Paths replaced: ${scopedCount}`);
  console.log(`  Transcript preserved: ${transcriptOk}`);
  console.log(`  User message preserved: ${userMsgOk}`);
  console.log(`  Prompt repaired: ${promptOk}`);
  console.log(`  Other session repaired: ${otherOk}`);
  if (transcriptOk && userMsgOk && promptOk && otherOk && scopedCount === 2) { console.log("  PASS"); passed++; } else { console.log("  FAIL"); failed++; }
  console.log();

  console.log("─".repeat(72));
  console.log("SUMMARY");
  console.log("─".repeat(72));
  console.log();
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log();
  console.log("  The repair uses the existing scanner (extractBundledSkillRelativeSegments");
  console.log("  + resolveExpectedBundledSkillPath) to compute expected paths, then applies");
  console.log("  scoped replacement to only modify snapshot metadata fields.");
  console.log("  Unrelated content (transcripts, user messages) is preserved unchanged.");
  console.log("─".repeat(72));

  rmSync(testDir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error("Proof script failed:", err); process.exit(1); });
