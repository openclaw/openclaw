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
  // This writes Claude's existing Desktop JSON shape into an isolated proof home.
  const metadataPath = path.join(directory, `local_${name}.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  return metadataPath;
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function levelDbTable(data) {
  const dataWithTrailer = Buffer.concat([data, Buffer.from([0, 0, 0, 0, 0])]);
  const handle = Buffer.concat([encodeVarint(0), encodeVarint(data.length)]);
  const indexEntry = Buffer.concat([Buffer.from([0, 1, handle.length, 0x78]), handle]);
  const index = Buffer.concat([indexEntry, Buffer.alloc(4), Buffer.from([1, 0, 0, 0])]);
  const indexWithTrailer = Buffer.concat([index, Buffer.alloc(5)]);
  const footer = Buffer.alloc(48);
  Buffer.concat([
    encodeVarint(0),
    encodeVarint(0),
    encodeVarint(dataWithTrailer.length),
    encodeVarint(index.length),
  ]).copy(footer);
  return Buffer.concat([dataWithTrailer, indexWithTrailer, footer]);
}

async function writeDesktopGroupStore(home, groupId, groupName, localSessionId) {
  const directory = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  await fs.mkdir(directory, { recursive: true });
  const userKey = Buffer.from("_https://claude.ai\0\x01dframe-store", "latin1");
  const trailer = Buffer.alloc(8);
  trailer[0] = 1;
  trailer[1] = 1;
  const key = Buffer.concat([userKey, trailer]);
  const value = Buffer.from(
    `{"id":"${groupId}","name":"${groupName}"}{"code:${localSessionId}":"${groupId}"}`,
  );
  const block = Buffer.concat([
    encodeVarint(0),
    encodeVarint(key.length),
    encodeVarint(value.length),
    key,
    value,
    Buffer.alloc(4),
    Buffer.from([1, 0, 0, 0]),
  ]);
  await fs.writeFile(path.join(directory, "000001.ldb"), levelDbTable(block));
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

async function runLargeCatalogCompatibilityCase() {
  const home = await createHome();
  const projectRoot = path.join(home, ".claude", "projects");
  const fileCount = 5;
  const sessionIds = [];
  for (let index = 0; index < fileCount; index += 1) {
    const sessionId = `large-budget-${index}`;
    sessionIds.push(sessionId);
    const directory = path.join(projectRoot, `-large-budget-${index}`);
    const transcript = path.join(directory, `${sessionId}.jsonl`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      transcript,
      `${JSON.stringify({
        type: "user",
        sessionId,
        entrypoint: "cli",
        uuid: `${sessionId}-1`,
        message: {
          role: "user",
          content: [{ type: "text", text: "Readable beyond the catalog budget" }],
        },
      })}\n`,
    );
    const entry = { sessionId, fullPath: transcript, summary: sessionId, isSidechain: false };
    const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
    const suffix = `"}`;
    const paddingBytes = aggregateBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(
      path.join(directory, "sessions-index.json"),
      `${prefix}${"x".repeat(paddingBytes)}${suffix}`,
    );
  }
  const startedAt = performance.now();
  const listing = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
  const listingMs = Math.round(performance.now() - startedAt);
  const omittedSessionIds = sessionIds.filter(
    (sessionId) => !listing.sessions.some((session) => session.threadId === sessionId),
  );
  const targetSessionId = omittedSessionIds[0] ?? sessionIds.at(-1);
  let transcript;
  try {
    const page = await readLocalClaudeTranscriptPage(
      { threadId: targetSessionId, limit: 1 },
      home,
      { includeDesktop: false },
    );
    transcript = page.items[0]?.text ?? null;
  } catch (error) {
    transcript = error instanceof Error ? error.message : String(error);
  }
  return {
    configuredFiles: fileCount,
    retained: listing.sessions.length,
    omitted: omittedSessionIds.length,
    listingError: listing.error?.code ?? null,
    targetTranscript: transcript,
    listingMs,
  };
}

async function runIndexOnlyUpgradeCase() {
  // Released scanners list sessions from a complete index even when their
  // transcripts carry no discoverable CLI user metadata. When the new admission
  // limits reject that index, the bounded probe must preserve the index-only
  // catalog row so an upgrade does not hide the session.
  const home = await createHome();
  const sessionId = "index-only-upgrade-session";
  const directory = path.join(home, ".claude", "projects", "-index-only-upgrade");
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  await fs.mkdir(directory, { recursive: true });
  // Progress-only transcript: direct discovery finds no CLI user metadata here.
  await fs.writeFile(transcript, `${JSON.stringify({ type: "progress", sessionId })}\n`);
  const entry = {
    sessionId,
    fullPath: transcript,
    summary: "Index-only upgrade session",
    isSidechain: false,
  };
  const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
  const suffix = `"}`;
  const paddingBytes =
    MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  await fs.writeFile(
    path.join(directory, "sessions-index.json"),
    `${prefix}${"x".repeat(paddingBytes)}${suffix}`,
  );
  const listing = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
  const record = listing.sessions.find((session) => session.threadId === sessionId) ?? null;
  let transcriptText;
  try {
    const page = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
      includeDesktop: false,
    });
    transcriptText = page.items[0]?.text ?? null;
  } catch (error) {
    transcriptText = error instanceof Error ? error.message : String(error);
  }
  return {
    listingError: listing.error?.code ?? null,
    retainedIndexOnlyRow: record !== null,
    name: record?.name ?? null,
    source: record?.source ?? null,
    transcriptText,
  };
}

async function runRejectedDesktopEnrichmentCase() {
  const home = await createHome();
  const sessionId = "desktop-recovered-enrichment";
  const localSessionId = "local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await writeIndexedSession(home, sessionId, {
    type: "user",
    sessionId,
    entrypoint: "cli",
    uuid: `${sessionId}-1`,
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Recovered Desktop session" }] },
  });
  const metadataPath = await writeDesktopMetadata(home, "recovered-enrichment", {
    cliSessionId: sessionId,
    sessionId: localSessionId,
    title: "Recovered Desktop session",
    prNumber: 111772,
    prState: "MERGED",
    prs: [
      { prNumber: 999, state: "CLOSED", dismissed: true },
      ...Array.from({ length: 1_000 }, (_value, index) => ({
        prNumber: index + 1,
        state: "CLOSED",
      })),
      { prNumber: 999, state: "OPEN" },
    ],
    padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
  });
  const metadataBeforeListing = await fs.readFile(metadataPath);
  await writeDesktopGroupStore(
    home,
    "cg-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    "Release",
    localSessionId,
  );
  const listing = await listLocalClaudeSessionPage({}, home);
  const recovered = listing.sessions.find((session) => session.threadId === sessionId);
  const existingMetadataUnchanged = metadataBeforeListing.equals(await fs.readFile(metadataPath));
  const expectedNumbers = [
    ...Array.from({ length: 18 }, (_value, index) => index + 981),
    1000,
    111772,
  ];
  if (
    listing.error?.code !== "LOCAL_CATALOG_PARTIAL" ||
    recovered?.customGroup !== "Release" ||
    !existingMetadataUnchanged ||
    JSON.stringify(recovered.pullRequest) !==
      JSON.stringify({ numbers: expectedNumbers, state: "merged" })
  ) {
    throw new Error("rejected Desktop metadata lost its custom group or bounded PR summary");
  }
  return {
    listingError: listing.error.code,
    retained: recovered !== undefined,
    customGroup: recovered.customGroup,
    pullRequest: recovered.pullRequest,
    dismissedPrExcluded: !recovered.pullRequest.numbers.includes(999),
    existingMetadataUnchanged,
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

async function runDesktopDescriptorRaceExclusionCase() {
  const home = await createHome();
  const sessionId = "excluded-desktop-descriptor-race";
  await writeIndexedSession(home, sessionId);
  const desktopPath = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
    "local_archived-descriptor-race.json",
  );
  await writeDesktopMetadata(home, "archived-descriptor-race", {
    cliSessionId: sessionId,
    isArchived: true,
  });
  const originalOpen = fs.open;
  let raced = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === desktopPath && !raced) {
      raced = true;
      await fs.appendFile(desktopPath, " ");
    }
    return handle;
  };
  try {
    const listing = await listLocalClaudeSessionPage({}, home);
    let transcript;
    try {
      await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home);
      transcript = "unexpectedly-readable";
    } catch (error) {
      transcript = error instanceof Error ? error.message : String(error);
    }
    return {
      listing: { error: listing.error?.code ?? null, sessions: listing.sessions.length },
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
      largeCatalogCompatibility: await runLargeCatalogCompatibilityCase(),
      indexOnlyUpgrade: await runIndexOnlyUpgradeCase(),
      rejectedDesktopEnrichment: await runRejectedDesktopEnrichmentCase(),
      directoryAdmission: await runDirectoryAdmissionCase(),
      partialLookupIndexOnlySidechain: await runPartialLookupExclusionCase("index-only-sidechain"),
      partialLookupForeignEntrypoint: await runPartialLookupExclusionCase("foreign"),
      descriptorRaceExclusion: await runDescriptorRaceExclusionCase(),
      desktopDescriptorRaceExclusion: await runDesktopDescriptorRaceExclusionCase(),
      partialLookupDesktopArchive: await runPartialLookupDesktopArchiveCase(),
      partialLookupPositive: await runPartialLookupPositiveCase(),
      negativeControl: await runNegativeControl(),
    }),
  );
} finally {
  await Promise.all(homes.map((home) => fs.rm(home, { recursive: true, force: true })));
}
