// Covers bounded catalog JSON admission: per-file and aggregate byte budgets,
// descriptor races, and upgrade visibility for index-only rows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionCatalogProvider as RegisteredSessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerClaudeSessionDiscovery } from "./session-catalog-registration.js";
import {
  MAX_CATALOG_JSON_CACHE_BYTES,
  MAX_CATALOG_JSON_FILE_BYTES,
  MAX_CATALOG_JSON_SCAN_BYTES,
  readJsonFile,
} from "./session-catalog-scan.js";
import { listLocalClaudeSessionPage } from "./session-catalog.js";

const originalHome = process.env.HOME;

type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
type SessionCatalogProvider = Omit<
  RegisteredSessionCatalogProvider,
  "list" | "read" | "continueSession" | "archive" | "openTerminal"
> & {
  list: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["list"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["list"]>;
  read: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["read"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["read"]>;
  continueSession?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>;
  archive?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["archive"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["archive"]>>;
  openTerminal?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>;
};

function bindTestCatalogOwner(provider: RegisteredSessionCatalogProvider): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(provider.continueSession
      ? {
          continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
        }
      : {}),
    ...(provider.archive
      ? { archive: (params) => provider.archive!({ agentId: "main", ...params }) }
      : {}),
    ...(provider.openTerminal
      ? {
          openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
        }
      : {}),
  } as SessionCatalogProvider;
}

function registerClaudeSessionCatalog(api: OpenClawPluginApi): void {
  registerClaudeSessionDiscovery({
    ...api,
    registerNodeHostCommand: api.registerNodeHostCommand ?? (() => {}),
  });
}

function captureCatalogProvider(runtime: PluginRuntime): SessionCatalogProvider {
  let provider: SessionCatalogProvider | undefined;
  const runtimeWithSession = {
    ...runtime,
    agent: runtime.agent ?? { session: { listSessionEntries: () => [] } },
  } as PluginRuntime;
  registerClaudeSessionCatalog({
    id: "anthropic",
    config: {},
    runtime: runtimeWithSession,
    registerSessionCatalog: (candidate: RegisteredSessionCatalogProvider) => {
      provider = bindTestCatalogOwner(candidate);
    },
  } as unknown as OpenClawPluginApi);
  if (!provider) {
    throw new Error("expected Anthropic session catalog registration");
  }
  return provider;
}

const homes: string[] = [];
async function createHome(): Promise<string> {
  // openclaw-temp-dir: allow per-home catalog fixture removed in afterEach
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-catalog-"));
  homes.push(home);
  return home;
}

async function expectClaudeCatalogEventually(
  home: string,
  assertion: (page: Awaited<ReturnType<typeof listLocalClaudeSessionPage>>) => void | Promise<void>,
  options: Parameters<typeof listLocalClaudeSessionPage>[0] = {},
) {
  return vi.waitFor(
    async () => {
      const page = await listLocalClaudeSessionPage(options, home);
      await assertion(page);
      return page;
    },
    { timeout: 2_000, interval: 25 },
  );
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
  options?: { pretty?: boolean },
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
  await fs.writeFile(
    path.join(dir, `local_${name}.json`),
    JSON.stringify(metadata, null, options?.pretty ? 2 : undefined),
  );
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

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Claude session catalog JSON budget", () => {
  it("does not buffer oversized catalog JSON files", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const indexPath = path.join(projectDir, "sessions-index.json");
    const desktopPath = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
      "local_oversized.json",
    );
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      indexPath,
      JSON.stringify({ version: 1, entries: [], padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES) }),
    );
    await writeDesktopMetadata(home, "oversized", {
      cliSessionId: "oversized-desktop-session",
      title: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });
    expect((await fs.stat(indexPath)).size).toBeGreaterThan(MAX_CATALOG_JSON_FILE_BYTES);
    expect((await fs.stat(desktopPath)).size).toBeGreaterThan(MAX_CATALOG_JSON_FILE_BYTES);

    const readFileSpy = vi.spyOn(fs, "readFile");
    const page = await listLocalClaudeSessionPage({}, home);
    expect(page.sessions).toEqual([]);
    expect(page.error).toEqual({
      code: "LOCAL_CATALOG_PARTIAL",
      message: expect.stringContaining("2 files"),
    });
    expect(readFileSpy.mock.calls.map(([filePath]) => filePath)).not.toEqual(
      expect.arrayContaining([indexPath, desktopPath]),
    );

    process.env.HOME = home;
    const provider = captureCatalogProvider({
      nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
    } as unknown as PluginRuntime);
    await expect(provider.list({ hostIds: ["gateway:local"] })).resolves.toEqual([
      expect.objectContaining({
        hostId: "gateway:local",
        sessions: [],
        error: expect.objectContaining({ code: "LOCAL_CATALOG_PARTIAL" }),
      }),
    ]);
  });

  it("keeps indexed archived sessions hidden when Desktop metadata exceeds the file budget", async () => {
    const home = await createHome();
    const sessionId = "oversized-archived-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`),
          summary: "Archived session",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Archived", 1)] },
    });
    await writeDesktopMetadata(home, "oversized-archived", {
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
      cliSessionId: sessionId,
      isArchived: true,
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("1 file"),
      },
    });
  });

  it("clears a cached partial status after Desktop metadata recovers", async () => {
    const home = await createHome();
    await writeDesktopMetadata(home, "recovered", {
      cliSessionId: "desktop-recovered-session",
      sessionId: "local-recovered-session",
      title: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES),
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("1 file"),
      },
    });
    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("1 file"),
      },
    });

    await writeDesktopMetadata(home, "recovered", {
      cliSessionId: "desktop-recovered-session",
      sessionId: "local-recovered-session",
      title: "Recovered Desktop metadata",
    });

    await expectClaudeCatalogEventually(home, (page) => {
      expect(page).toMatchObject({ sessions: [] });
      expect(page.error).toBeUndefined();
    });
  });

  it("bounds aggregate catalog JSON bytes and weights the parse cache", async () => {
    const home = await createHome();
    const smallSessionId = "small-catalog-session";
    await writeIndexedDesktopSession(home, {
      sessionId: smallSessionId,
      localSessionId: "local_small-catalog-session",
      metadataName: "small-catalog",
      title: "Small catalog",
      prompt: "small catalog prompt",
    });
    await expect(listLocalClaudeSessionPage({ limit: 100 }, home)).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          threadId: smallSessionId,
          name: "Small catalog",
          source: "claude-desktop",
        }),
      ],
    });

    const projectRoot = path.join(home, ".claude", "projects");
    const largeFileBytes =
      Math.floor(Math.min(MAX_CATALOG_JSON_CACHE_BYTES, MAX_CATALOG_JSON_SCAN_BYTES) / 5) + 1;
    const largeIndexPaths: string[] = [];
    const largeSessionIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const sessionId = `large-catalog-session-${index}`;
      const projectDir = path.join(projectRoot, `project-${index}`);
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      const indexPath = path.join(projectDir, "sessions-index.json");
      await fs.mkdir(projectDir, { recursive: true });
      const entry = {
        sessionId,
        fullPath: transcriptPath,
        summary: sessionId,
        isSidechain: false,
      };
      const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
      const suffix = `"}`;
      const paddingBytes = largeFileBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
      await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "progress", sessionId })}\n`);
      largeIndexPaths.push(indexPath);
      largeSessionIds.push(sessionId);
    }

    const refreshed = await listLocalClaudeSessionPage({ limit: 100 }, home);
    expect(refreshed.error).toEqual({
      code: "LOCAL_CATALOG_PARTIAL",
      message: expect.stringContaining("1 file"),
    });
    expect(refreshed.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: smallSessionId,
          name: "Small catalog",
          source: "claude-desktop",
        }),
      ]),
    );
    const retainedLargeSessionIds = refreshed.sessions
      .map((session) => session.threadId)
      .filter((sessionId) => largeSessionIds.includes(sessionId))
      .toSorted();
    // Rejected indexes keep their bounded index-only rows, so the aggregate
    // budget no longer drops the fifth session's catalog visibility.
    expect(retainedLargeSessionIds).toEqual(largeSessionIds.toSorted());

    const openSpy = vi.spyOn(fs, "open");
    for (const indexPath of largeIndexPaths) {
      await readJsonFile(indexPath);
    }
    openSpy.mockClear();
    for (const indexPath of largeIndexPaths) {
      await readJsonFile(indexPath);
    }
    expect(
      openSpy.mock.calls.some(([filePath]) => largeIndexPaths.includes(String(filePath))),
    ).toBe(true);
  });

  it("keeps an index-only session visible when JSON admission rejects its index", async () => {
    const home = await createHome();
    const sessionId = "rejected-index-only-session";
    const projectDir = path.join(home, ".claude", "projects", "-oversized-index");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    const entry = {
      sessionId,
      fullPath: transcriptPath,
      summary: "Index-only rejected summary",
      firstPrompt: "Index-only rejected prompt",
      created: 1789000000000,
      isSidechain: false,
    };
    // The index exceeds the per-file admission limit, so only the bounded
    // probe reads its entries.
    const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
    const suffix = `"}`;
    const paddingBytes =
      MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
    // Progress-only transcript: direct discovery finds no CLI user metadata,
    // so the catalog row must come from the rejected index itself.
    await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "progress", sessionId })}\n`);

    const listed = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
    expect(listed.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        threadId: sessionId,
        name: "Index-only rejected summary",
        source: "claude-cli",
        createdAt: 1789000000000,
      }),
    ]);
  });

  it("keeps a rejected-index string whose encoded form exceeds the legacy token cap", async () => {
    const home = await createHome();
    const sessionId = "escaped-rejected-index-session";
    const projectDir = path.join(home, ".claude", "projects", "-escaped-oversized-index");
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const indexPath = path.join(projectDir, "sessions-index.json");
    await fs.mkdir(projectDir, { recursive: true });
    // Each é costs six encoded characters, so the encoded summary token exceeds
    // 1,024 characters while its decoded form stays within the 500-char cap.
    const summary = "é".repeat(200);
    const entry = {
      sessionId,
      fullPath: transcriptPath,
      summary: "__ESCAPED_SUMMARY__",
      created: 1789000000000,
      isSidechain: false,
    };
    const entryText = JSON.stringify(entry).replace(
      '"__ESCAPED_SUMMARY__"',
      `"${"\\u00e9".repeat(200)}"`,
    );
    const prefix = `{"version":1,"entries":[${entryText}],"padding":"`;
    const suffix = `"}`;
    const paddingBytes =
      MAX_CATALOG_JSON_FILE_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
    await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "progress", sessionId })}\n`);

    const listed = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
    expect(listed.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        threadId: sessionId,
        name: summary,
        source: "claude-cli",
      }),
    ]);
  });

  it("recovers a minimal Desktop record when admission rejects the metadata file", async () => {
    const home = await createHome();
    const sessionId = "desktop-only-rejected-metadata";
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    await fs.mkdir(projectDir, { recursive: true });
    // Progress-only transcript: no CLI index entry and no CLI user metadata, so
    // the desktop-only session must come from the rejected metadata probe.
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "progress", sessionId })}\n`,
    );
    await writeDesktopMetadata(home, "rejected-metadata", {
      cliSessionId: sessionId,
      title: "Desktop only rejected row",
      cwd: "/work/openclaw",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-02T00:00:00.000Z",
      padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES + 1),
    });

    const listed = await listLocalClaudeSessionPage({}, home);
    expect(listed.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        threadId: sessionId,
        name: "Desktop only rejected row",
        cwd: "/work/openclaw",
        source: "claude-desktop",
      }),
    ]);
  });

  it("charges a cached Desktop overlay against a later CLI scan budget", async () => {
    const home = await createHome();
    await writeDesktopMetadata(home, "large-cached-overlay", {
      cliSessionId: "desktop-only-cached-overlay",
      sessionId: "local-desktop-only-cached-overlay",
      title: "Cached Desktop overlay",
      padding: "x".repeat(15 * 1024 * 1024),
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toEqual({ sessions: [] });

    const projectRoot = path.join(home, ".claude", "projects");
    const largeFileBytes = Math.floor(MAX_CATALOG_JSON_SCAN_BYTES / 5) + 1;
    const largeSessionIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const sessionId = `warm-budget-session-${index}`;
      const projectDir = path.join(projectRoot, `project-${index}`);
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      const indexPath = path.join(projectDir, "sessions-index.json");
      await fs.mkdir(projectDir, { recursive: true });
      const entry = {
        sessionId,
        fullPath: transcriptPath,
        summary: sessionId,
        isSidechain: false,
      };
      const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
      const suffix = `"}`;
      const paddingBytes = largeFileBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
      await fs.writeFile(transcriptPath, `${JSON.stringify({ type: "progress", sessionId })}\n`);
      largeSessionIds.push(sessionId);
    }

    const refreshed = await listLocalClaudeSessionPage({}, home);
    expect(refreshed.error).toMatchObject({ code: "LOCAL_CATALOG_PARTIAL" });
    expect(refreshed.sessions.map((session) => session.threadId)).toEqual(largeSessionIds);
  });

  it("re-admits a warm Desktop overlay against the fresh aggregate budget", async () => {
    const home = await createHome();
    const desktopSessionId = "warm-desktop-session";
    const largeFileBytes = Math.floor(MAX_CATALOG_JSON_SCAN_BYTES / 5) + 1;
    await writeIndexedDesktopSession(home, {
      sessionId: desktopSessionId,
      localSessionId: "local_warm-desktop-session",
      metadataName: "warm-desktop",
      title: "Warm Desktop title",
      prompt: "warm desktop prompt",
      metadata: { padding: "x".repeat(largeFileBytes) },
    });
    await expect(listLocalClaudeSessionPage({ limit: 100 }, home)).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          threadId: desktopSessionId,
          source: "claude-desktop",
        }),
      ],
    });

    const projectRoot = path.join(home, ".claude", "projects");
    for (let index = 0; index < 5; index += 1) {
      const sessionId = `warm-budget-${index}`;
      const projectDir = path.join(projectRoot, `warm-budget-${index}`);
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      const indexPath = path.join(projectDir, "sessions-index.json");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(transcriptPath, `${JSON.stringify({ sessionId })}\n`);
      const entry = { sessionId, fullPath: transcriptPath, summary: sessionId, isSidechain: false };
      const prefix = `{"version":1,"entries":${JSON.stringify([entry])},"padding":"`;
      const suffix = `"}`;
      const paddingBytes = largeFileBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      await fs.writeFile(indexPath, `${prefix}${"x".repeat(paddingBytes)}${suffix}`);
    }

    const refreshed = await listLocalClaudeSessionPage({ limit: 100 }, home);
    expect(refreshed.error).toEqual({
      code: "LOCAL_CATALOG_PARTIAL",
      message: expect.stringContaining("2 files"),
    });
    expect(refreshed.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: desktopSessionId,
          source: "claude-desktop",
        }),
      ]),
    );
  });

  it("keeps the catalog JSON cap across a stat-to-open replacement race", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const filePath = path.join(projectDir, "sessions-index.json");
    const replacementPath = path.join(projectDir, "sessions-index.replacement.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 1, entries: [] }));
    await fs.writeFile(
      replacementPath,
      JSON.stringify({ version: 1, entries: [], padding: "x".repeat(MAX_CATALOG_JSON_FILE_BYTES) }),
    );

    const open = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === filePath && !replaced) {
        await fs.rename(replacementPath, filePath);
        replaced = true;
      }
      return await open(...args);
    });

    await expect(readJsonFile(filePath)).resolves.toBeUndefined();
    expect(replaced).toBe(true);
  });

  it("reports a partial catalog when an admitted JSON file changes size before open", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const filePath = path.join(projectDir, "sessions-index.json");
    const replacementPath = path.join(projectDir, "sessions-index.replacement.json");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 1, entries: [] }));
    await fs.writeFile(
      replacementPath,
      JSON.stringify({ version: 1, entries: [], padding: "valid replacement" }),
    );

    const open = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === filePath && !replaced) {
        await fs.rename(replacementPath, filePath);
        replaced = true;
      }
      return await open(...args);
    });

    const page = await listLocalClaudeSessionPage({}, home, { includeDesktop: false });
    expect(page).toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("changed while being read"),
      },
    });
    expect(replaced).toBe(true);
  });

  it("reports a partial catalog when a Desktop metadata read ends early", async () => {
    const home = await createHome();
    const desktopDir = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
    );
    const filePath = path.join(desktopDir, "local_active.json");
    await fs.mkdir(desktopDir, { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ cliSessionId: "desktop-race", sessionId: "local-race" }),
    );

    const open = fs.open.bind(fs);
    let readCalls = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === filePath) {
        const realRead = handle.read.bind(handle);
        Object.defineProperty(handle, "read", {
          configurable: true,
          value: (buffer: Buffer, offset: number, length: number, position: number) => {
            readCalls += 1;
            if (readCalls === 1) {
              return { bytesRead: 0, buffer };
            }
            return realRead(buffer, offset, length, position);
          },
        });
      }
      return handle;
    });

    const page = await listLocalClaudeSessionPage({}, home);
    expect(page).toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("changed while being read"),
      },
    });
    // The failed JSON read is followed by the bounded archive probe so a late rejection can
    // still preserve Desktop archive exclusions.
    expect(readCalls).toBeGreaterThanOrEqual(2);
  });

  it("reports a partial catalog when a Desktop metadata file disappears during admission", async () => {
    const home = await createHome();
    const desktopDir = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
    );
    const filePath = path.join(desktopDir, "local_admission-race.json");
    await fs.mkdir(desktopDir, { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ cliSessionId: "desktop-admission-race", sessionId: "local-race" }),
    );

    const stat = fs.stat.bind(fs);
    let failAdmission = true;
    vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      if (target === filePath && failAdmission) {
        failAdmission = false;
        throw new Error("simulated Desktop metadata admission race");
      }
      return await stat(target);
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("could not be read"),
      },
    });
    expect(failAdmission).toBe(false);
  });

  it("reports a partial catalog when Desktop metadata admission finds a directory", async () => {
    const home = await createHome();
    const desktopDir = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
    );
    const filePath = path.join(desktopDir, "local_directory-race.json");
    await fs.mkdir(filePath, { recursive: true });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [],
      error: {
        code: "LOCAL_CATALOG_PARTIAL",
        message: expect.stringContaining("could not be read"),
      },
    });
  });

  it("preserves catalog JSON across short descriptor reads", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const filePath = path.join(projectDir, "sessions-index.json");
    const expected = { version: 1, entries: [], padding: "short read regression" };
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(expected));

    const open = fs.open.bind(fs);
    let readCalls = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === filePath) {
        const realRead = handle.read.bind(handle);
        Object.defineProperty(handle, "read", {
          configurable: true,
          value: (buffer: Buffer, offset: number, length: number, position: number) => {
            readCalls += 1;
            return realRead(buffer, offset, Math.min(3, length), position);
          },
        });
      }
      return handle;
    });

    await expect(readJsonFile(filePath)).resolves.toEqual(expected);
    expect(readCalls).toBeGreaterThan(1);
  });

  it("reports a partial catalog when a descriptor read ends before its reserved size", async () => {
    const home = await createHome();
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    const filePath = path.join(projectDir, "sessions-index.json");
    const prefix = JSON.stringify({ version: 1, entries: [] });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(filePath, `${prefix}${"x".repeat(8)}`);

    const open = fs.open.bind(fs);
    let readCalls = 0;
    const onIoFailure = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === filePath) {
        const realRead = handle.read.bind(handle);
        Object.defineProperty(handle, "read", {
          configurable: true,
          value: (buffer: Buffer, offset: number, length: number, position: number) => {
            readCalls += 1;
            if (readCalls === 1) {
              return realRead(buffer, offset, prefix.length, position);
            }
            return { bytesRead: 0, buffer };
          },
        });
      }
      return handle;
    });

    await expect(readJsonFile(filePath, { onIoFailure })).resolves.toBeUndefined();
    expect(readCalls).toBe(2);
    expect(onIoFailure).toHaveBeenCalledOnce();
  });
});
