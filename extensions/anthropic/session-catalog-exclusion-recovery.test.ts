// Covers Desktop and index exclusion recovery plus transcript-lookup boundary
// cases for the Claude session catalog.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDesktopOverlay } from "./session-catalog-desktop.js";
import {
  createCatalogJsonReadBudget,
  MAX_CATALOG_JSON_FILE_BYTES,
} from "./session-catalog-scan.js";
import { listLocalClaudeSessionPage, readLocalClaudeTranscriptPage } from "./session-catalog.js";

const homes: string[] = [];

async function createHome(): Promise<string> {
  // openclaw-temp-dir: allow per-home catalog fixture removed in afterEach
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-catalog-"));
  homes.push(home);
  return home;
}

async function writeProject(params: {
  home: string;
  project?: string;
  entries: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries }),
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([sessionId, rows]) =>
      fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ),
  );
}

async function writeDesktopMetadata(
  home: string,
  name: string,
  metadata: Record<string, unknown>,
  _options?: { pretty?: boolean },
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `local_${name}.json`), JSON.stringify(metadata));
}

async function writeIndexedDesktopSession(
  home: string,
  params: {
    sessionId: string;
    localSessionId: string;
    metadataName: string;
    title: string;
    prompt: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { sessionId, localSessionId, metadataName, title, prompt, metadata } = params;
  await writeProject({
    home,
    entries: [
      {
        sessionId,
        fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
        projectPath: "/work/openclaw",
        isSidechain: false,
      },
    ],
    transcripts: { [sessionId]: [message(sessionId, "user", prompt, 1)] },
  });
  await writeDesktopMetadata(home, metadataName, {
    sessionId: localSessionId,
    cliSessionId: sessionId,
    cwd: "/work/openclaw",
    title,
    ...metadata,
  });
}

function message(
  sessionId: string,
  type: "user" | "assistant",
  text: string | Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  return {
    type,
    sessionId,
    uuid: `${sessionId}-${index}`,
    timestamp: `2026-07-0${index}T00:00:00.000Z`,
    isSidechain: false,
    message: {
      role: type,
      content: typeof text === "string" ? [{ type: "text", text }] : text,
      ...(type === "assistant" ? { model: "claude-opus-4-8" } : {}),
    },
  };
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function levelDbTable(data: Buffer): Buffer {
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

async function writeDesktopGroups(
  home: string,
  groups: Array<{ groupId: string; localSessionId: string; name: string }>,
): Promise<void> {
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
    groups
      .flatMap(({ groupId, localSessionId, name }) => [
        JSON.stringify({ id: groupId, name }),
        JSON.stringify({ [`code:${localSessionId}`]: groupId }),
      ])
      .join(""),
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Claude session catalog exclusions and recovery", () => {
  it("preserves Desktop source when active metadata is over the JSON limit", async () => {
    const home = await createHome();
    const sessionId = "desktop-over-limit-source";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId: "local-desktop-over-limit-source",
      metadataName: "over-limit-source",
      title: "Desktop source",
      prompt: "Desktop source prompt",
      metadata: { padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES) },
    });

    const page = await listLocalClaudeSessionPage({ limit: 100 }, home);
    expect(page).toMatchObject({
      error: { code: "LOCAL_CATALOG_PARTIAL" },
      sessions: [
        expect.objectContaining({
          threadId: sessionId,
          source: "claude-desktop",
        }),
      ],
    });
  });

  it("keeps a specific transcript readable when its index is beyond the scan budget", async () => {
    const home = await createHome();
    const sessionId = "catalog-lookup-beyond-budget";
    const projectDir = path.join(home, ".claude", "projects", "-target");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    const entry = {
      sessionId,
      fullPath: transcriptPath,
      summary: "Beyond-budget session",
      isSidechain: false,
    };
    const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
    const suffix = `"}`;
    const paddingBytes =
      MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify(message(sessionId, "user", "Readable beyond budget", 1))}\n`,
    );

    await expect(
      listLocalClaudeSessionPage({}, home, { includeDesktop: false }),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: sessionId, name: "Beyond-budget session" })],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
        includeDesktop: false,
      }),
    ).resolves.toMatchObject({
      threadId: sessionId,
      items: [expect.objectContaining({ type: "userMessage", text: "Readable beyond budget" })],
    });
  });

  it.each([
    {
      name: "sidechain",
      row: {
        ...message("excluded-session", "user", "Sidechain", 1),
        entrypoint: "cli",
        isSidechain: true,
      },
      indexIsSidechain: true,
      indexEntry: true,
      oversizedIndex: false,
    },
    {
      name: "index-only sidechain",
      row: {
        ...message("excluded-session", "user", "Index-only sidechain", 1),
        entrypoint: "cli",
      },
      indexIsSidechain: true,
      indexEntry: true,
      oversizedIndex: true,
    },
    {
      name: "foreign entrypoint",
      row: { ...message("excluded-session", "user", "Foreign", 1), entrypoint: "sdk" },
      indexIsSidechain: false,
      indexEntry: false,
      oversizedIndex: false,
    },
  ])(
    "does not bypass the $name exclusion for a partial transcript lookup",
    async ({ name, row, indexIsSidechain, indexEntry, oversizedIndex }) => {
      const home = await createHome();
      const sessionId = "excluded-session";
      const projectDir = path.join(home, ".claude", "projects", "-excluded");
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      const indexPath = path.join(projectDir, "sessions-index.json");
      await fs.mkdir(projectDir, { recursive: true });
      const entry = {
        sessionId,
        fullPath: transcriptPath,
        isSidechain: indexIsSidechain,
        ...(oversizedIndex ? { firstPrompt: "x".repeat(256 * 1024) } : {}),
      };
      const indexContent = JSON.stringify({ version: 1, entries: indexEntry ? [entry] : [] });
      if (oversizedIndex) {
        const prefix = `{"version":1,"entries":[${JSON.stringify(entry)}],"padding":"`;
        const suffix = `"}`;
        const paddingBytes =
          MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
        await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
      } else {
        await fs.writeFile(indexPath, indexContent);
      }
      const oversizedProjectDir = path.join(home, ".claude", "projects", "-unrelated");
      const oversizedIndexPath = path.join(oversizedProjectDir, "sessions-index.json");
      await fs.mkdir(oversizedProjectDir, { recursive: true });
      const prefix = `{"version":1,"entries":[],"padding":"`;
      const suffix = `"}`;
      const paddingBytes =
        MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      await fs.writeFile(oversizedIndexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
      await fs.writeFile(transcriptPath, `${JSON.stringify(row)}\n`);

      if (name === "index-only sidechain") {
        await expect(
          listLocalClaudeSessionPage({}, home, { includeDesktop: false }),
        ).resolves.toMatchObject({
          sessions: [],
          error: { code: "LOCAL_CATALOG_PARTIAL" },
        });
      }
      await expect(
        readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
          includeDesktop: false,
        }),
      ).rejects.toThrow("Claude session is unavailable");
    },
  );

  it("recovers sidechain exclusions when an admitted index grows before its read", async () => {
    const home = await createHome();
    const sessionId = "descriptor-race-sidechain";
    const projectDir = path.join(home, ".claude", "projects", "-descriptor-race");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        entries: [{ sessionId, fullPath: transcriptPath, isSidechain: true }],
      }),
    );
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ sessionId, entrypoint: "cli", type: "user", message: { content: "hidden" } })}\n`,
    );
    const realOpen = fs.open.bind(fs);
    let raced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === indexPath && !raced) {
        raced = true;
        await fs.appendFile(indexPath, " ");
      }
      return handle;
    });

    await expect(
      listLocalClaudeSessionPage({}, home, { includeDesktop: false }),
    ).resolves.toMatchObject({
      sessions: [],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home, {
        includeDesktop: false,
      }),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("does not bypass a skipped Desktop archive for a partial transcript lookup", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-partial-lookup";
    const projectDir = path.join(home, ".claude", "projects", "-archived");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeProject({
      home,
      project: "-archived",
      entries: [{ sessionId, fullPath: transcriptPath, isSidechain: false }],
      transcripts: { [sessionId]: [message(sessionId, "user", "Archived", 1)] },
    });
    await writeDesktopMetadata(home, "archived-partial-lookup", {
      cliSessionId: sessionId,
      isArchived: true,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("recovers a Desktop archive when metadata grows after admission", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-descriptor-race";
    const projectDir = path.join(home, ".claude", "projects", "-archived-race");
    const desktopPath = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
      "local_archived-race.json",
    );
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeProject({
      home,
      project: "-archived-race",
      entries: [{ sessionId, fullPath: transcriptPath, isSidechain: false }],
      transcripts: { [sessionId]: [message(sessionId, "user", "Archived", 1)] },
    });
    await writeDesktopMetadata(home, "archived-race", {
      cliSessionId: sessionId,
      isArchived: true,
    });

    const realOpen = fs.open.bind(fs);
    let raced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === desktopPath && !raced) {
        raced = true;
        await fs.appendFile(desktopPath, " ");
      }
      return handle;
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
    expect(raced).toBe(true);
    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("removes an active duplicate when a skipped Desktop archive is discovered", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-duplicate";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "CLI duplicate",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Duplicate", 1)] },
    });
    await writeDesktopMetadata(home, "active", {
      cliSessionId: sessionId,
      title: "Active duplicate",
    });
    await writeDesktopMetadata(home, "archived", {
      cliSessionId: sessionId,
      isArchived: true,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({ sessions: [] });
  });

  it("recognizes archived Desktop metadata when JSON booleans use whitespace delimiters", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-whitespace";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "CLI duplicate",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Duplicate", 1)] },
    });
    await writeDesktopMetadata(home, "active", { cliSessionId: sessionId });
    await writeDesktopMetadata(
      home,
      "archived",
      {
        cliSessionId: sessionId,
        padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
        isArchived: true,
      },
      { pretty: true },
    );

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({ sessions: [] });
  });

  it("recognizes archived Desktop metadata after escaped strings", async () => {
    const home = await createHome();
    const sessionId = "desktop-archive-escaped";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "CLI duplicate",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Duplicate", 1)] },
    });
    await writeDesktopMetadata(home, "active", { cliSessionId: sessionId });
    await writeDesktopMetadata(home, "archived", {
      cliSessionId: sessionId,
      title: 'Archived "title"',
      isArchived: true,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({ sessions: [] });
  });

  it("preserves Desktop group and bounded PR summary across per-file rejection", async () => {
    const home = await createHome();
    const admittedId = "desktop-admitted-pr-summary";
    const recoveredId = "desktop-recovered-pr-summary";
    const admittedLocalId = "local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const recoveredLocalId = "local_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const currentPr = 111772;
    const metadata = {
      prNumber: currentPr,
      prState: "MERGED",
      prs: [
        { prNumber: 999, state: "CLOSED", dismissed: true },
        ...Array.from({ length: 1_000 }, (_value, index) => ({
          prNumber: index + 1,
          state: "CLOSED",
        })),
        { prNumber: 999, state: "OPEN" },
      ],
    };
    await writeIndexedDesktopSession(home, {
      sessionId: admittedId,
      localSessionId: admittedLocalId,
      metadataName: "admitted-pr-summary",
      title: "Admitted Desktop session",
      prompt: "admitted prompt",
      metadata,
    });
    await writeIndexedDesktopSession(home, {
      sessionId: recoveredId,
      localSessionId: recoveredLocalId,
      metadataName: "recovered-pr-summary",
      title: "Recovered Desktop session",
      prompt: "recovered prompt",
      metadata: { ...metadata, padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES) },
    });
    await writeDesktopGroups(home, [
      {
        groupId: "cg-cccccccc-cccc-cccc-cccc-cccccccccccc",
        localSessionId: admittedLocalId,
        name: "Release",
      },
      {
        groupId: "cg-dddddddd-dddd-dddd-dddd-dddddddddddd",
        localSessionId: recoveredLocalId,
        name: "Release",
      },
    ]);

    const page = await listLocalClaudeSessionPage({ limit: 100 }, home);
    const admitted = page.sessions.find((session) => session.threadId === admittedId);
    const recovered = page.sessions.find((session) => session.threadId === recoveredId);
    const expectedPullRequest = {
      numbers: [...Array.from({ length: 18 }, (_value, index) => index + 981), 1000, currentPr],
      state: "merged",
    };
    expect(page.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    expect(admitted).toMatchObject({ customGroup: "Release", pullRequest: expectedPullRequest });
    expect(recovered).toMatchObject({ customGroup: "Release", pullRequest: expectedPullRequest });
    expect(recovered?.customGroup).toBe(admitted?.customGroup);
    expect(recovered?.pullRequest).toEqual(admitted?.pullRequest);
  });

  it("preserves Desktop enrichment when aggregate admission is exhausted", async () => {
    const home = await createHome();
    const sessionId = "desktop-aggregate-budget-metadata";
    const localSessionId = "local_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId,
      metadataName: "aggregate-budget-metadata",
      title: "Aggregate budget Desktop session",
      prompt: "aggregate budget prompt",
      metadata: {
        prNumber: 111773,
        prState: "OPEN",
        prs: [{ prNumber: 111771, state: "CLOSED" }],
      },
    });
    await writeDesktopGroups(home, [
      {
        groupId: "cg-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        localSessionId,
        name: "Release",
      },
    ]);
    const budget = createCatalogJsonReadBudget();
    budget.remainingBytes = 0;

    const overlay = await readDesktopOverlay(home, true, budget);

    expect(overlay.skippedFiles).toBe(1);
    expect(overlay.active.get(sessionId)).toMatchObject({
      customGroup: "Release",
      pullRequest: { numbers: [111771, 111773], state: "open" },
    });
  });

  it("preserves Desktop group and PR summary after late metadata rejection", async () => {
    const home = await createHome();
    const sessionId = "desktop-late-rejected-metadata";
    const localSessionId = "local_ffffffff-ffff-ffff-ffff-ffffffffffff";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId,
      metadataName: "late-rejected-metadata",
      title: "Late rejected Desktop session",
      prompt: "late rejected prompt",
      metadata: {
        prNumber: 111774,
        prState: "MERGED",
        prs: [
          { prNumber: 111770, state: "CLOSED" },
          { prNumber: 111772, state: "OPEN", dismissed: true },
        ],
      },
    });
    await writeDesktopGroups(home, [
      {
        groupId: "cg-ffffffff-ffff-ffff-ffff-ffffffffffff",
        localSessionId,
        name: "Release",
      },
    ]);
    const desktopPath = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
      "local_late-rejected-metadata.json",
    );
    const realOpen = fs.open.bind(fs);
    let raced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === desktopPath && !raced) {
        raced = true;
        await fs.appendFile(desktopPath, " ");
      }
      return handle;
    });

    const page = await listLocalClaudeSessionPage({}, home);

    expect(raced).toBe(true);
    expect(page).toMatchObject({
      sessions: [
        {
          threadId: sessionId,
          source: "claude-desktop",
          customGroup: "Release",
          pullRequest: { numbers: [111770, 111774], state: "merged" },
        },
      ],
      error: { code: "LOCAL_CATALOG_PARTIAL" },
    });
  });

  it("keeps recovered Desktop timestamps numeric with admitted ordering parity", async () => {
    const home = await createHome();
    const admittedId = "admitted-older";
    const recoveredId = "desktop-recovered";
    await writeProject({
      home,
      entries: [
        {
          sessionId: admittedId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${admittedId}.jsonl`),
          isSidechain: false,
          created: 1789000000000,
          modified: 1789086400000,
        },
        {
          sessionId: recoveredId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${recoveredId}.jsonl`),
          isSidechain: false,
        },
      ],
      transcripts: {
        [admittedId]: [message(admittedId, "user", "Admitted older", 1)],
        [recoveredId]: [message(recoveredId, "user", "Desktop recovered prompt", 1)],
      },
    });
    await writeDesktopMetadata(home, "recovered", {
      sessionId: "local-desktop-recovered",
      cliSessionId: recoveredId,
      cwd: "/work/openclaw",
      title: "Desktop recovered",
      createdAt: 1789086500000,
      lastActivityAt: 1789172900000,
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    const page = await listLocalClaudeSessionPage({ limit: 100 }, home);
    expect(page.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    expect(page.sessions.map((session) => session.threadId)).toEqual([recoveredId, admittedId]);
    expect(page.sessions[0]).toMatchObject({
      createdAt: 1789086500000,
      updatedAt: 1789172900000,
      recencyAt: 1789172900000,
      source: "claude-desktop",
    });
  });

  it("recovers index entries with JSON decimal and exponent timestamps and rejects truncated tokens", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-numeric");
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    const cases = [
      { sessionId: "numeric-decimal", created: "1789000000000.5" },
      { sessionId: "numeric-exponent", created: "1.789e12" },
      { sessionId: "numeric-overflow", created: "1789000000000.12345" },
    ];
    for (const { sessionId } of cases) {
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify(message(sessionId, "user", "Numeric recovery", 1))}\n`,
      );
    }
    const rawEntry = (sessionId: string, created: string) =>
      `{"sessionId":"${sessionId}","fullPath":${JSON.stringify(
        path.join(projectDir, `${sessionId}.jsonl`),
      )},"isSidechain":false,"created":${created}}`;
    const prefix = `{"version":1,"entries":[${cases
      .map(({ sessionId, created }) => rawEntry(sessionId, created))
      .join(",")}],"padding":"`;
    const suffix = `"}`;
    const paddingBytes =
      MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);

    const page = await listLocalClaudeSessionPage({ limit: 100 }, home, {
      includeDesktop: false,
    });
    expect(page.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    const byId = new Map(page.sessions.map((session) => [session.threadId, session]));
    expect(byId.get("numeric-decimal")?.createdAt).toBe(1789000000000.5);
    expect(byId.get("numeric-exponent")?.createdAt).toBe(1789000000000);
    expect(byId.get("numeric-overflow")?.createdAt).toBeUndefined();
  });
});
