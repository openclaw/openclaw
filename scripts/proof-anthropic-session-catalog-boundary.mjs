import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const { listLocalClaudeSessionPage, readLocalClaudeTranscriptPage } = await import(
  pathToFileURL(path.join(repoRoot, "extensions/anthropic/session-catalog-listing.ts")).href
);
const homes = [];
const MAX_CATALOG_JSON_FILE_BYTES = 16 * 1024 * 1024;
const aggregateBytes = Math.floor((64 * 1024 * 1024) / 5) + 1;

async function createHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr126604-proof-"));
  homes.push(home);
  return home;
}

async function writeDesktopMetadata(home, name, metadata) {
  const directory = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `local_${name}.json`), JSON.stringify(metadata));
}

async function writeIndexedSession(home, sessionId, row = { sessionId }) {
  const directory = path.join(home, ".claude", "projects", "-workspace");
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [{ sessionId, fullPath: transcript, summary: "CLI title", isSidechain: false }],
    }),
  );
  await fs.writeFile(transcript, `${JSON.stringify(row)}\n`);
}

async function runWarmOverlayCase() {
  const home = await createHome();
  const sessionId = "warm-desktop-session";
  await writeIndexedSession(home, sessionId);
  await writeDesktopMetadata(home, "active", {
    cliSessionId: sessionId,
    sessionId: `local-${sessionId}`,
    title: "Warm Desktop title",
    padding: "x".repeat(aggregateBytes),
  });
  const first = await listLocalClaudeSessionPage({ limit: 100 }, home);
  const projectRoot = path.join(home, ".claude", "projects");
  for (let index = 0; index < 5; index += 1) {
    const largeSessionId = `warm-budget-${index}`;
    const directory = path.join(projectRoot, `warm-budget-${index}`);
    const transcript = path.join(directory, `${largeSessionId}.jsonl`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(transcript, `${JSON.stringify({ sessionId: largeSessionId })}\n`);
    const entry = {
      sessionId: largeSessionId,
      fullPath: transcript,
      summary: largeSessionId,
      isSidechain: false,
    };
    const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
    const suffix = `"}`;
    const paddingBytes = aggregateBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(
      path.join(directory, "sessions-index.json"),
      `${prefix}${"x".repeat(paddingBytes)}${suffix}`,
    );
  }
  const second = await listLocalClaudeSessionPage({ limit: 100 }, home);
  const warm = second.sessions.find((session) => session.threadId === sessionId);
  return {
    firstSource: first.sessions.find((session) => session.threadId === sessionId)?.source ?? null,
    secondSource: warm?.source ?? null,
    secondError: second.error?.code ?? null,
  };
}

async function runDirectoryAdmissionCase() {
  const home = await createHome();
  const filePath = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
    "local_directory-race.json",
  );
  await fs.mkdir(filePath, { recursive: true });
  const page = await listLocalClaudeSessionPage({}, home);
  return { error: page.error?.code ?? null, sessions: page.sessions.length };
}

async function runPartialLookupExclusionCase(kind) {
  const home = await createHome();
  const sessionId = `excluded-${kind}`;
  const projectDir = path.join(home, ".claude", "projects", `-${kind}`);
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectDir, { recursive: true });
  const entry = {
    sessionId,
    fullPath: transcriptPath,
    summary: "excluded session",
    isSidechain: kind === "index-only-sidechain",
    ...(kind === "index-only-sidechain" ? { firstPrompt: "x".repeat(256 * 1024) } : {}),
  };
  const indexPath = path.join(projectDir, "sessions-index.json");
  if (kind === "index-only-sidechain") {
    const prefix = `{"version":1,"entries":[${JSON.stringify(entry)}],"padding":"`;
    const suffix = `"}`;
    const paddingBytes =
      MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
  } else {
    await fs.writeFile(
      indexPath,
      JSON.stringify({ version: 1, entries: kind === "foreign" ? [] : [entry] }),
    );
  }
  const oversizedProjectDir = path.join(home, ".claude", "projects", "-unrelated");
  const oversizedIndexPath = path.join(oversizedProjectDir, "sessions-index.json");
  await fs.mkdir(oversizedProjectDir, { recursive: true });
  const prefix = `{"version":1,"entries":[],"padding":"`;
  const suffix = `"}`;
  const paddingBytes =
    MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  await fs.writeFile(oversizedIndexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
  const row =
    kind === "index-only-sidechain"
      ? { sessionId, entrypoint: "cli" }
      : { sessionId, entrypoint: "sdk" };
  await fs.writeFile(transcriptPath, `${JSON.stringify(row)}\n`);
  const listing = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
  let transcript;
  try {
    await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
      includeDesktop: false,
    });
    transcript = "unexpectedly-readable";
  } catch (error) {
    transcript = error instanceof Error ? error.message : String(error);
  }
  return {
    listing: { error: listing.error?.code ?? null, sessions: listing.sessions.length },
    transcript,
  };
}

async function runDescriptorRaceExclusionCase() {
  const home = await createHome();
  const sessionId = "excluded-descriptor-race";
  const projectDir = path.join(home, ".claude", "projects", "-descriptor-race");
  const indexPath = path.join(projectDir, "sessions-index.json");
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      entries: [{ sessionId, fullPath: transcriptPath, isSidechain: true }],
    }),
  );
  await fs.writeFile(transcriptPath, `${JSON.stringify({ sessionId, entrypoint: "cli" })}\n`);
  const originalOpen = fs.open;
  let raced = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === indexPath && !raced) {
      raced = true;
      await fs.appendFile(indexPath, " ");
    }
    return handle;
  };
  try {
    const page = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
    let transcript;
    try {
      await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
        includeDesktop: false,
      });
      transcript = "unexpectedly-readable";
    } catch (error) {
      transcript = error instanceof Error ? error.message : String(error);
    }
    return {
      listing: { error: page.error?.code ?? null, sessions: page.sessions.length },
      transcript,
      raced,
    };
  } finally {
    fs.open = originalOpen;
  }
}

async function runPartialLookupDesktopArchiveCase() {
  const home = await createHome();
  const sessionId = "excluded-desktop-archive";
  await writeIndexedSession(home, sessionId);
  await writeDesktopMetadata(home, "archived", {
    cliSessionId: sessionId,
    isArchived: true,
    padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
  });
  try {
    await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home);
    return { result: "unexpectedly-readable" };
  } catch (error) {
    return { result: error instanceof Error ? error.message : String(error) };
  }
}

async function runPartialLookupPositiveCase() {
  const home = await createHome();
  const sessionId = "partial-readable-session";
  const projectDir = path.join(home, ".claude", "projects", "-readable");
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: [] }),
  );
  const oversizedProjectDir = path.join(home, ".claude", "projects", "-unrelated");
  const oversizedIndexPath = path.join(oversizedProjectDir, "sessions-index.json");
  await fs.mkdir(oversizedProjectDir, { recursive: true });
  const prefix = `{"version":1,"entries":[],"padding":"`;
  const suffix = `"}`;
  const paddingBytes =
    MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  await fs.writeFile(oversizedIndexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      sessionId,
      uuid: `${sessionId}-1`,
      timestamp: "2026-07-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Readable partial fallback" }] },
    })}\n`,
  );
  try {
    const page = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
      includeDesktop: false,
    });
    return { result: page.items[0]?.text ?? null };
  } catch (error) {
    return { result: error instanceof Error ? error.message : String(error) };
  }
}

async function runNegativeControl() {
  const home = await createHome();
  const sessionId = "valid-session";
  await writeIndexedSession(home, sessionId);
  const page = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
  return { error: page.error?.code ?? null, sessions: page.sessions.length };
}

try {
  console.log(
    JSON.stringify({
      sha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
      warmOverlay: await runWarmOverlayCase(),
      directoryAdmission: await runDirectoryAdmissionCase(),
      partialLookupIndexOnlySidechain: await runPartialLookupExclusionCase("index-only-sidechain"),
      partialLookupForeignEntrypoint: await runPartialLookupExclusionCase("foreign"),
      descriptorRaceExclusion: await runDescriptorRaceExclusionCase(),
      partialLookupDesktopArchive: await runPartialLookupDesktopArchiveCase(),
      partialLookupPositive: await runPartialLookupPositiveCase(),
      negativeControl: await runNegativeControl(),
    }),
  );
} finally {
  await Promise.all(homes.map((home) => fs.rm(home, { recursive: true, force: true })));
}
