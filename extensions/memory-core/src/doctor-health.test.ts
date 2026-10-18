import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HealthCheck, HealthCheckContext } from "openclaw/plugin-sdk/health";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
  registerMemoryCoreDoctorChecks,
} from "./doctor-health.js";
import { collectVectorProviderFindings } from "./doctor-vector-index-provider.js";

type InspectManagedLocalEmbeddingSetup = Parameters<
  typeof registerMemoryCoreDoctorChecks
>[0]["inspectEmbeddingProviderSetup"];

const roots = new Set<string>();
const model = "embeddinggemma-300m";
const setupFailure = {
  reason: "Local embeddings need the managed llama.cpp server config.",
  requirement: "managed-llama-cpp-setup",
};

async function createState(index: string | false = model) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-"));
  roots.add(stateDir);
  if (index !== false) {
    await createSemanticIndex(stateDir, index);
  }
  return stateDir;
}

function agentDatabasePath(stateDir: string, agentId = "main") {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function expectedSetupFinding() {
  return [
    expect.objectContaining({ requirement: "managed-llama-cpp-setup", target: "main/local" }),
  ];
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function createSemanticIndex(stateDir: string, indexModel = model, agentId = "main") {
  const databasePath = agentDatabasePath(stateDir, agentId);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
    "memory_index_meta_v1",
    JSON.stringify({ model: indexModel, vectorDims: 768 }),
  );
  db.close();
  return databasePath;
}

function captureCheck(
  inspectManagedLocalEmbeddingSetup?: InspectManagedLocalEmbeddingSetup,
  memoryCoreActive = true,
): HealthCheck {
  const checks = new Map<string, HealthCheck>();
  registerMemoryCoreDoctorChecks({
    registerHealthCheck(check) {
      checks.set(check.id, check);
    },
    getHealthCheck: (id) => checks.get(id),
    inspectEmbeddingProviderSetup: inspectManagedLocalEmbeddingSetup ?? (async () => undefined),
    memoryCoreActive,
  });
  const check = checks.get(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID);
  if (!check) {
    throw new Error("expected managed local embedding setup check");
  }
  return check;
}

function context(stateDir: string, provider: string): HealthCheckContext {
  return {
    mode: "lint",
    runtime: {} as HealthCheckContext["runtime"],
    cfg: { memory: { search: { provider, fallback: "none" } } },
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
}

describe("managed local embedding setup health check", () => {
  it("refreshes current host state and re-registers after a registry reset", async () => {
    const stateDir = await createState();
    const checks = new Map<string, HealthCheck>();
    const registerHealthCheck = vi.fn((check: HealthCheck) => {
      if (checks.has(check.id)) {
        throw new Error(`duplicate check: ${check.id}`);
      }
      checks.set(check.id, check);
    });
    const getHealthCheck = (id: string) => checks.get(id);
    const staleInspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
    const currentInspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async (params) => ({
      provider: params.provider,
      ...setupFailure,
    }));

    const register = (
      inspectEmbeddingProviderSetup: InspectManagedLocalEmbeddingSetup,
      memoryCoreActive = true,
    ) =>
      registerMemoryCoreDoctorChecks({
        registerHealthCheck,
        getHealthCheck,
        inspectEmbeddingProviderSetup,
        memoryCoreActive,
      });
    register(staleInspect, false);
    const check = checks.get(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID);
    if (!check) {
      throw new Error("expected managed local embedding setup check");
    }

    register(currentInspect);
    expect(registerHealthCheck).toHaveBeenCalledOnce();
    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual(expectedSetupFinding());
    expect(staleInspect).not.toHaveBeenCalled();
    expect(currentInspect).toHaveBeenCalledOnce();

    checks.clear();
    register(currentInspect);
    expect(checks.get(MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID)).toBe(check);
    expect(registerHealthCheck).toHaveBeenCalledTimes(2);
  });

  it("passes configured local setup and ignores non-local providers", async () => {
    const stateDir = await createState();
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
    const check = captureCheck(inspect);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
    await expect(check.detect(context(stateDir, "openai"))).resolves.toEqual([]);
    expect(inspect.mock.calls.map(([params]) => params.provider)).toEqual(["local"]);
  });

  it("snapshots only local agents while preserving their setup findings", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-setup-mixed-"));
    roots.add(stateDir);
    for (const agentId of ["default", "disabled", "local"]) {
      await createSemanticIndex(stateDir, "embeddinggemma-300m", agentId);
    }
    const snapshot = vi.spyOn(sqliteRuntime, "prepareSqliteReadOnlyLocation");
    try {
      const check = captureCheck();
      await expect(
        check.detect({
          ...context(stateDir, "auto"),
          cfg: {
            agents: {
              entries: {
                default: {},
                disabled: { memory: { search: { provider: "local", enabled: false } } },
                local: { memory: { search: { provider: "local" } } },
              },
            },
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          target: "local/local",
          path: "agents.entries.local.memory.search.provider",
          requirement: "memory-embedding-provider-plugin",
        }),
      ]);
      expect(snapshot.mock.calls.map(([databasePath]) => databasePath)).toEqual([
        path.join(stateDir, "agents", "local", "agent", "openclaw-agent.sqlite"),
      ]);
    } finally {
      snapshot.mockRestore();
    }
  });

  it("reports a structured blocker when the local provider plugin is unavailable", async () => {
    const stateDir = await createState();
    const check = captureCheck();

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
      expect.objectContaining({
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        target: "main/local",
        requirement: "memory-embedding-provider-plugin",
        message: expect.stringMatching(/official llama.cpp provider plugin.*llama-server/s),
        fixHint: expect.stringContaining("openclaw plugins install @openclaw/llama-cpp-provider"),
      }),
    ]);
  });

  it("ignores stale built-in indexes when another plugin owns the memory slot", async () => {
    const stateDir = await createState();
    const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => ({
      provider: "local",
      reason: setupFailure.reason,
    }));
    const check = captureCheck(inspect, false);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["missing", "fts-only"] as const)(
    "does not inspect a provider for a %s vector index",
    async (indexMode) => {
      const stateDir = await createState(indexMode === "fts-only" ? "fts-only" : false);
      const inspect = vi.fn<InspectManagedLocalEmbeddingSetup>(async () => null);
      const check = captureCheck(inspect);

      await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([]);
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it("reads an active WAL index without changing committed database or WAL bytes", async () => {
    const stateDir = await createState(false);
    const databasePath = agentDatabasePath(stateDir);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      writer
        .prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)")
        .run("memory_index_meta_v1", JSON.stringify({ model, vectorDims: 768 }));
      // Ordinary SQLite readers may update read marks in the shared-memory sidecar.
      const familyPaths = ["", "-wal"].map((suffix) => `${databasePath}${suffix}`);
      const before = await Promise.all(familyPaths.map(async (file) => await fs.readFile(file)));
      const check = captureCheck(async (params) => ({
        provider: params.provider,
        ...setupFailure,
      }));

      await expect(check.detect(context(stateDir, "local"))).resolves.toEqual(
        expectedSetupFinding(),
      );
      const after = await Promise.all(familyPaths.map(async (file) => await fs.readFile(file)));
      expect(after).toEqual(before);
    } finally {
      writer.close();
    }
  });

  it("verifies the stored vector model while the live agent database receives continuous commits", async () => {
    const stateDir = await createState();
    const databasePath = agentDatabasePath(stateDir);
    const seed = openNodeSqliteDatabase(databasePath);
    try {
      // A 64 MiB main file makes a raw copy overlap many real WAL commits.
      seed.exec(`
        CREATE TABLE payloads (value BLOB NOT NULL) STRICT;
        WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 1024)
        INSERT INTO payloads SELECT zeroblob(65536) FROM rows;
        CREATE TABLE heartbeat (value INTEGER NOT NULL) STRICT;
        INSERT INTO heartbeat VALUES (0);
      `);
    } finally {
      seed.close();
    }

    // A separate process keeps committing even when a synchronous inspector blocks Node.
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = NORMAL;");
      const write = db.prepare("UPDATE heartbeat SET value = value + 1");
      write.run();
      setInterval(() => write.run(), 1);
      process.stdout.write("ready\\n");
      setTimeout(() => process.exit(2), 25000);
    `,
        databasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    writer.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(writer, "close");
    try {
      await Promise.race([
        once(writer.stdout, "data"),
        closed.then(() => {
          throw new Error(`SQLite writer exited before readiness: ${stderr}`);
        }),
      ]);
      const checkContext = context(stateDir, "local");
      const config = checkContext.cfg;
      const env = checkContext.env!;
      const check = captureCheck(async () => null);
      await expect(check.detect(checkContext)).resolves.toEqual([]);
      await expect(
        collectVectorProviderFindings(
          { config, env, stateDir, shouldInspectAgent: () => true },
          async () => ({
            provider: "local",
            reason: "Synthetic provider setup requirement",
          }),
        ),
      ).resolves.toEqual([
        {
          agentId: "main",
          model,
          provider: "local",
          configPrefix: "memory.search",
          reason: "Synthetic provider setup requirement",
        },
      ]);
      expect(writer.exitCode).toBeNull();
      const reader = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(reader.prepare("SELECT value FROM heartbeat").get()?.value).toBeGreaterThan(1);
      } finally {
        reader.close();
      }
    } finally {
      writer.kill();
      await closed;
    }
  }, 30_000);

  it("returns a structured non-ready result when an agent database cannot be inspected", async () => {
    const stateDir = await createState(false);
    const databasePath = agentDatabasePath(stateDir);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database");
    const check = captureCheck(async () => null);

    await expect(check.detect(context(stateDir, "local"))).resolves.toEqual([
      {
        checkId: MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
        severity: "error",
        source: "memory-core",
        target: "memory-core",
        requirement: "memory-index-inspection",
        message: expect.stringContaining(
          "Memory Core semantic-index readiness could not be verified",
        ),
        fixHint:
          "Keep the current Gateway running, resolve the database inspection error, then rerun this check.",
      },
    ]);
  });
});
