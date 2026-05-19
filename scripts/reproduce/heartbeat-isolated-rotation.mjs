#!/usr/bin/env node
// Reproducer for #65564: isolated-session heartbeat rotation orphans the prior
// transcript on disk unless the same-key archive path runs. Exercises the real
// updateSessionStore + archiveRemovedSessionTranscripts code paths against an
// on-disk session store and transcript; no vitest, no mocks.
//
// Usage:
//   node --import tsx scripts/reproduce/heartbeat-isolated-rotation.mjs
//   node --import tsx scripts/reproduce/heartbeat-isolated-rotation.mjs --skip-archive  # simulate pre-fix main
import { mkdtempSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  archiveRemovedSessionTranscripts,
  updateSessionStore,
} from "../../src/config/sessions/store.js";

const skipArchive = process.argv.includes("--skip-archive");

const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-rotation-repro-"));
const storePath = join(tmpDir, "session-store.json");
const isolatedSessionKey = "main:agent:heartbeat";
const previousSessionId = "previous-isolated-sid";
const newSessionId = "fresh-isolated-sid";
const transcriptPath = join(dirname(storePath), `${previousSessionId}.jsonl`);

writeFileSync(
  storePath,
  JSON.stringify({
    [isolatedSessionKey]: {
      sessionId: previousSessionId,
      updatedAt: Date.now(),
      lastChannel: "test",
      lastProvider: "test",
      lastTo: "+1555",
    },
  }),
  "utf-8",
);
writeFileSync(transcriptPath, '{"type":"message","content":"prior heartbeat turn"}\n', "utf-8");

console.log("# Setup");
console.log(`store: ${storePath}`);
console.log(`transcript: ${transcriptPath}`);
console.log(
  `mode: ${skipArchive ? "PRE-FIX (skip archive call)" : "POST-FIX (archive on rotate)"}`,
);
console.log();

const rotatedSessionFiles = new Map();
let referencedSessionIds = new Set();
await updateSessionStore(storePath, (store) => {
  const previousEntry = store[isolatedSessionKey];
  if (previousEntry?.sessionId === previousSessionId) {
    rotatedSessionFiles.set(previousEntry.sessionId, previousEntry.sessionFile);
  }
  store[isolatedSessionKey] = {
    sessionId: newSessionId,
    updatedAt: Date.now(),
    lastChannel: "test",
    lastProvider: "test",
    lastTo: "+1555",
  };
  referencedSessionIds = new Set(
    Object.values(store)
      .map((e) => e?.sessionId)
      .filter(Boolean),
  );
});

if (!skipArchive && rotatedSessionFiles.size > 0) {
  await archiveRemovedSessionTranscripts({
    removedSessionFiles: rotatedSessionFiles,
    referencedSessionIds,
    storePath,
    reason: "reset",
    restrictToStoreDir: true,
  });
}

console.log("# Disk state after rotation");
const dirEntries = readdirSync(dirname(storePath)).sort();
for (const entry of dirEntries) {
  const stat = statSync(join(dirname(storePath), entry));
  console.log(`  ${entry}  (${stat.size} bytes)`);
}
console.log();

const transcriptStillThere = (() => {
  try {
    statSync(transcriptPath);
    return true;
  } catch {
    return false;
  }
})();
const archivedMatches = dirEntries.filter((e) => e.startsWith(`${previousSessionId}.jsonl.reset.`));

console.log("# Observed");
console.log(`  prior transcript at original path exists? ${transcriptStillThere}`);
console.log(`  archived copies (.jsonl.reset.<ts>): ${archivedMatches.length}`);
const store = JSON.parse(readFileSync(storePath, "utf-8"));
console.log(`  store[isolatedSessionKey].sessionId: ${store[isolatedSessionKey].sessionId}`);
console.log();

if (skipArchive) {
  if (transcriptStillThere) {
    console.log("# Result: BUG REPRODUCED");
    console.log("  Prior transcript is orphaned on disk under the previous sessionId,");
    console.log("  while the store entry now points at a different sessionId.");
  } else {
    console.log("# Result: unexpected — transcript missing without the archive call");
  }
} else {
  if (!transcriptStillThere && archivedMatches.length === 1) {
    console.log("# Result: FIX VERIFIED");
    console.log("  Prior transcript was archived to .jsonl.reset.<ts>; original path is empty.");
  } else {
    console.log("# Result: unexpected — fix did not produce the archived rename");
  }
}

rmSync(tmpDir, { recursive: true, force: true });
