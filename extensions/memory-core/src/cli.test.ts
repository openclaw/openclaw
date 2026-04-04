import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  firstWrittenJsonArg,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "../../../src/cli/test-runtime-capture.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  })),
);

vi.mock("./cli.host.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./cli.host.runtime.js")>("./cli.host.runtime.js");
  return {
    ...actual,
    getMemorySearchManager,
    loadConfig,
    resolveCommandSecretRefsViaGateway,
    resolveDefaultAgentId,
  };
});

let registerMemoryCli: typeof import("./cli.js").registerMemoryCli;
let defaultRuntime: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").defaultRuntime;
let isVerbose: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").isVerbose;
let setVerbose: typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli").setVerbose;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./cli.js"));
  ({ defaultRuntime, isVerbose, setVerbose } =
    await import("openclaw/plugin-sdk/memory-core-host-runtime-cli"));
});

beforeEach(() => {
  getMemorySearchManager.mockReset();
  loadConfig.mockReset().mockReturnValue({});
  resolveDefaultAgentId.mockReset().mockReturnValue("main");
  resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  setVerbose(false);
});

describe("memory cli", () => {
  const inactiveMemorySecretDiagnostic = "agents.defaults.memorySearch.remote.apiKey inactive"; // pragma: allowlist secret

  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  function setupMemoryStatusWithInactiveSecretDiagnostics(close: ReturnType<typeof vi.fn>) {
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig: {},
      diagnostics: [inactiveMemorySecretDiagnostic] as string[],
    });
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });
  }

  function hasLoggedInactiveSecretDiagnostic(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.some(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes(inactiveMemorySecretDiagnostic),
    );
  }

  async function waitFor<T>(task: () => Promise<T>, timeoutMs: number = 1500): Promise<T> {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Timed out waiting for async test condition");
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  function captureHelpOutput(command: Command | undefined) {
    let output = "";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      command?.outputHelp();
      return output;
    } finally {
      writeSpy.mockRestore();
    }
  }

  function getMemoryHelpText() {
    const program = new Command();
    registerMemoryCli(program);
    const memoryCommand = program.commands.find((command) => command.name() === "memory");
    return captureHelpOutput(memoryCommand);
  }

  async function withQmdIndexDb(content: string, run: (dbPath: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-qmd-index-"));
    const dbPath = path.join(tmpDir, "index.sqlite");
    try {
      await fs.writeFile(dbPath, content, "utf-8");
      await run(dbPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-promote-"));
    try {
      await run(workspaceDir);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("resolves configured memory SecretRefs through gateway snapshot", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: { source: "env", provider: "default", id: "MEMORY_REMOTE_API_KEY" },
            },
          },
        },
      },
    });
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status"]);

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "memory status",
        targetIds: new Set([
          "agents.defaults.memorySearch.remote.apiKey",
          "agents.list[].memorySearch.remote.apiKey",
        ]),
      }),
    );
  });

  it("logs gateway secret diagnostics for non-json status output", async () => {
    const close = vi.fn(async () => {});
    setupMemoryStatusWithInactiveSecretDiagnostics(close);

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(hasLoggedInactiveSecretDiagnostic(log)).toBe(true);
  });

  it("documents memory help examples", () => {
    const helpText = getMemoryHelpText();

    expect(helpText).toContain("openclaw memory status --deep");
    expect(helpText).toContain("Probe embedding provider readiness.");
    expect(helpText).toContain('openclaw memory search "meeting notes"');
    expect(helpText).toContain("Quick search using positional query.");
    expect(helpText).toContain('openclaw memory search --query "deployment" --max-results 20');
    expect(helpText).toContain("Limit results for focused troubleshooting.");
    expect(helpText).toContain("openclaw memory promote --apply");
    expect(helpText).toContain("Append top-ranked short-term candidates into MEMORY.md.");
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, close });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("logs qmd index file path and size after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD index: "));
      expect(log).toHaveBeenCalledWith("Memory index updated (main).");
      expect(close).toHaveBeenCalled();
    });
  });

  it("fails index when qmd db file is empty", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const error = spyRuntimeErrors(defaultRuntime);
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Memory index failed (main): QMD index file is empty"),
      );
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });

  it("prints status json output when requested", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["status", "--json"]);

    const payload = firstWrittenJsonArg<unknown[]>(writeJson);
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error("expected json payload");
    }
    expect(Array.isArray(payload)).toBe(true);
    expect((payload[0] as Record<string, unknown>)?.agentId).toBe("main");
    expect(close).toHaveBeenCalled();
  });

  it("routes gateway secret diagnostics to stderr for json status output", async () => {
    const close = vi.fn(async () => {});
    setupMemoryStatusWithInactiveSecretDiagnostics(close);

    const writeJson = spyRuntimeJson(defaultRuntime);
    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["status", "--json"]);

    const payload = firstWrittenJsonArg<unknown[]>(writeJson);
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error("expected json payload");
    }
    expect(Array.isArray(payload)).toBe(true);
    expect(hasLoggedInactiveSecretDiagnostic(error)).toBe(true);
  });

  it("logs default message when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValueOnce({ manager: null });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith("Memory search disabled.");
  });

  it("logs backend unsupported message when index has no sync", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () => makeMemoryStatus(),
      close,
    });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["index"]);

    expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
    expect(close).toHaveBeenCalled();
  });

  it("prints no matches for empty search results", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["search", "hello"]);

    expect(search).toHaveBeenCalledWith("hello", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:main:cli:direct:memory-search",
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
  });

  it("accepts --query for memory search", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["search", "--query", "deployment notes"]);

    expect(search).toHaveBeenCalledWith("deployment notes", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:main:cli:direct:memory-search",
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prefers --query when positional and flag are both provided", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    spyRuntimeLogs(defaultRuntime);
    await runMemoryCli(["search", "positional", "--query", "flagged"]);

    expect(search).toHaveBeenCalledWith("flagged", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:main:cli:direct:memory-search",
    });
    expect(close).toHaveBeenCalled();
  });

  it("fails when neither positional query nor --query is provided", async () => {
    const error = spyRuntimeErrors(defaultRuntime);
    await runMemoryCli(["search"]);

    expect(error).toHaveBeenCalledWith(
      "Missing search query. Provide a positional query or use --query <text>.",
    );
    expect(getMemorySearchManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints search results as json when requested", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    mockManager({ search, close });

    const writeJson = spyRuntimeJson(defaultRuntime);
    await runMemoryCli(["search", "hello", "--json"]);

    const payload = firstWrittenJsonArg<{ results: unknown[] }>(writeJson);
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error("expected json payload");
    }
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results).toHaveLength(1);
    expect(close).toHaveBeenCalled();
  });

  it("records short-term recall entries from memory search hits", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const close = vi.fn(async () => {});
      const search = vi.fn(async () => [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.91,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ]);
      mockManager({
        search,
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      await runMemoryCli(["search", "glacier", "--json"]);

      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      const storeRaw = await waitFor(async () => await fs.readFile(storePath, "utf-8"));
      const store = JSON.parse(storeRaw) as {
        entries?: Record<string, { path: string; recallCount: number }>;
      };
      const entries = Object.values(store.entries ?? {});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        path: "memory/2026-04-03.md",
        recallCount: 1,
      });
      expect(close).toHaveBeenCalled();
    });
  });

  it("prints no candidates when promote has no short-term recall data", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli(["promote"]);

      expect(log).toHaveBeenCalledWith("No short-term recall candidates.");
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("prints promote candidates as json", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router notes",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 4,
            endLine: 8,
            score: 0.86,
            snippet: "Configured VLAN 10 for IoT on router",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const writeJson = spyRuntimeJson(defaultRuntime);
      await runMemoryCli([
        "promote",
        "--json",
        "--min-score",
        "0",
        "--min-recall-count",
        "0",
        "--min-unique-queries",
        "0",
      ]);

      const payload = firstWrittenJsonArg<{ candidates: unknown[] }>(writeJson);
      expect(payload).not.toBeNull();
      if (!payload) {
        throw new Error("expected json payload");
      }
      expect(Array.isArray(payload.candidates)).toBe(true);
      expect(payload.candidates).toHaveLength(1);
      expect(close).toHaveBeenCalled();
    });
  });

  it("applies top promote candidates into MEMORY.md", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "network setup",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 10,
            endLine: 14,
            score: 0.91,
            snippet: "Gateway host uses local mode and binds loopback port 18789",
            source: "memory",
          },
        ],
      });

      const close = vi.fn(async () => {});
      mockManager({
        status: () => makeMemoryStatus({ workspaceDir }),
        close,
      });

      const log = spyRuntimeLogs(defaultRuntime);
      await runMemoryCli([
        "promote",
        "--apply",
        "--min-score",
        "0",
        "--min-recall-count",
        "0",
        "--min-unique-queries",
        "0",
      ]);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).toContain("Promoted From Short-Term Memory");
      expect(memoryText).toContain("memory/2026-04-01.md:10-14");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Promoted 1 candidate(s) to"));
      expect(close).toHaveBeenCalled();
    });
  });
});
