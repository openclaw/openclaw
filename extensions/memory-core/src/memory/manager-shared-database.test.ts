import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { acquireSharedMemoryDatabase, resolveSharedMemoryIndexScope } =
  await import("./manager-shared-database.js");

const fixture = createManagerIndexFixture({
  getMemorySearchManager,
  closeAllMemorySearchManagers,
});

function createSharedConfig(
  params: {
    provider?: string;
    sources?: Array<"memory" | "sessions">;
    vectorEnabled?: boolean;
  } = {},
): OpenClawConfig {
  const base = fixture.createConfig({
    provider: params.provider ?? "none",
    sources: params.sources ?? ["memory"],
    vectorEnabled: params.vectorEnabled ?? false,
    minScore: 0,
  });
  const workspace = fixture.paths.workspace;
  return {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        workspace,
        systemAgent: { agentId: "main" },
      },
      list: [
        { id: "main", default: true, workspace },
        { id: "orion", workspace },
      ],
    },
  } as OpenClawConfig;
}

function withAgentSearch(
  cfg: OpenClawConfig,
  agentId: string,
  search: Record<string, unknown>,
): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: cfg.agents?.list?.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              memory: {
                ...agent.memory,
                search: {
                  ...agent.memory?.search,
                  ...search,
                },
              },
            }
          : agent,
      ),
    },
  } as OpenClawConfig;
}

function withoutSystemAgent(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        systemAgent: undefined,
      },
    },
  } as OpenClawConfig;
}

function resolveScope(cfg: OpenClawConfig, agentId: string) {
  const settings = resolveMemorySearchConfig(cfg, agentId);
  if (!settings) {
    return null;
  }
  return resolveSharedMemoryIndexScope({
    cfg,
    agentId,
    settings,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  });
}

function requireManager(result: Awaited<ReturnType<typeof getMemorySearchManager>>) {
  if (!result.manager) {
    throw new Error(result.error ?? "memory manager missing");
  }
  fixture.trackManager(result.manager as never);
  return result.manager;
}

describe("shared memory database scope", () => {
  it("uses the system agent's explicit canonical workspace", () => {
    const cfg = createSharedConfig();
    const sharedWorkspace = fixture.paths.workspace;
    const privateWorkspace = path.join(sharedWorkspace, "private");
    cfg.agents!.defaults!.workspace = sharedWorkspace;
    cfg.agents!.list = [
      { id: "main", default: true, workspace: privateWorkspace },
      { id: "orion", workspace: privateWorkspace },
    ];

    expect(resolveAgentWorkspaceDir(cfg, "main")).toBe(privateWorkspace);
    expect(resolveScope(cfg, "main")?.workspaceDir).toBe(privateWorkspace);
    expect(
      resolveSharedMemoryIndexScope({
        cfg,
        agentId: "orion",
        settings: resolveMemorySearchConfig(cfg, "orion")!,
        workspaceDir: sharedWorkspace,
      }),
    ).toBeNull();
  });

  it("requires current system and requesting agent membership", () => {
    const cfg = createSharedConfig();
    const systemWorkspace = fixture.paths.workspace;
    expect(resolveScope(cfg, "orion")).not.toBeNull();
    expect(resolveScope(withoutSystemAgent(cfg), "orion")).toBeNull();

    cfg.agents!.list = [{ id: "main", default: true, workspace: systemWorkspace }];
    expect(resolveScope(cfg, "orion")).toBeNull();

    const reassigned = createSharedConfig();
    reassigned.agents!.defaults!.systemAgent = { agentId: "orion" };
    const reassignedOrion = reassigned.agents!.list!.find((agent) => agent.id === "orion");
    if (!reassignedOrion) {
      throw new Error("fixture agent missing");
    }
    reassignedOrion.workspace = path.join(systemWorkspace, "other");
    expect(resolveScope(reassigned, "main")).toBeNull();
  });

  it("does not share agent-specific session sources", () => {
    const cfg = createSharedConfig({ sources: ["memory", "sessions"] });
    cfg.memory!.search!.experimental = { sessionMemory: true };
    expect(resolveScope(cfg, "orion")).toBeNull();
  });

  it.each([
    ["model", { model: "different-model" }],
    ["provider", { provider: "fixture-provider" }],
    ["extra paths", { extraPaths: ["private-notes"] }],
    ["FTS tokenizer", { store: { fts: { tokenizer: "trigram" } } }],
    ["multimodal", { multimodal: { enabled: true, maxFileBytes: 1024 } }],
    ["vector storage", { store: { vector: { enabled: true } } }],
    ["input type", { inputType: "different-input" }],
    ["local model path", { local: { modelPath: "/tmp/different-model.gguf" } }],
  ])("requires compatible %s settings", (_label, search) => {
    const cfg = createSharedConfig();
    const different = withAgentSearch(cfg, "orion", search);
    expect(resolveScope(different, "orion")).toBeNull();
  });
});

describe("shared memory database ownership", () => {
  it("keeps one owner alive until the final lease releases and can reopen cleanly", () => {
    const scope = {
      compatibilityHash: "test-compatibility",
      path: path.join(fixture.paths.root, "shared-owner.sqlite"),
      systemAgentId: "main",
      workspaceDir: fixture.paths.workspace,
    };
    const first = acquireSharedMemoryDatabase({
      allowExtension: false,
      readOnly: false,
      scope,
    });
    const second = acquireSharedMemoryDatabase({
      allowExtension: false,
      readOnly: false,
      scope,
    });

    expect(first.db).toBe(second.db);
    expect(existsSync(scope.path)).toBe(true);

    first.release();
    expect(second.db.isOpen).toBe(true);

    second.release();
    expect(second.db.isOpen).toBe(false);

    const reopened = acquireSharedMemoryDatabase({
      allowExtension: false,
      readOnly: false,
      scope,
    });
    try {
      expect(reopened.db.isOpen).toBe(true);
    } finally {
      reopened.release();
    }
  });

  it("keeps status reads read-only and does not create a missing database", () => {
    const missingPath = path.join(fixture.paths.root, "status-missing.sqlite");
    const missing = acquireSharedMemoryDatabase({
      allowExtension: false,
      readOnly: true,
      scope: {
        compatibilityHash: "status-missing",
        path: missingPath,
        systemAgentId: "main",
        workspaceDir: fixture.paths.workspace,
      },
    });
    try {
      expect(existsSync(missingPath)).toBe(false);
      expect(missing.db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    } finally {
      missing.release();
    }

    const existingPath = path.join(fixture.paths.root, "status-existing.sqlite");
    const scope = {
      compatibilityHash: "status-existing",
      path: existingPath,
      systemAgentId: "main",
      workspaceDir: fixture.paths.workspace,
    };
    const writer = acquireSharedMemoryDatabase({
      allowExtension: false,
      readOnly: false,
      scope,
    });
    try {
      ensureMemoryIndexSchema({ cacheEnabled: true, db: writer.db, ftsEnabled: false });
      writer.db.exec("CREATE TABLE sentinel (value TEXT)");
      writer.db.prepare("INSERT INTO sentinel VALUES (?)").run("present");
    } finally {
      writer.release();
    }

    const reader = acquireSharedMemoryDatabase({
      allowExtension: false,
      readOnly: true,
      scope,
    });
    try {
      expect(reader.db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
      expect(reader.db.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "present" });
    } finally {
      reader.release();
    }
  });
});

describe("shared memory manager integration", () => {
  it("lets compatible agents share one live index and search the same documents", async () => {
    const cfg = createSharedConfig();
    const main = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main" }),
    ) as never as {
      close(): Promise<void>;
      db: { isOpen: boolean };
      search(query: string): Promise<Array<{ snippet: string }>>;
      status(): { dbPath: string };
      sync(params: { reason: string }): Promise<void>;
    };
    const orion = requireManager(
      await getMemorySearchManager({ cfg, agentId: "orion" }),
    ) as never as {
      close(): Promise<void>;
      db: { isOpen: boolean };
      search(query: string): Promise<Array<{ snippet: string }>>;
      status(): { dbPath: string };
      sync(params: { reason: string }): Promise<void>;
    };

    const mainStatus = main.status();
    const orionStatus = orion.status();
    expect(mainStatus.dbPath).toBe(orionStatus.dbPath);
    expect(mainStatus.dbPath).toContain(`${path.sep}memory${path.sep}shared-`);
    expect(main.db).toBe(orion.db);

    await main.sync({ reason: "test" });
    const results = await orion.search("Alpha");
    expect(results.some((entry) => /Alpha/i.test(entry.snippet))).toBe(true);

    const status = requireManager(
      await getMemorySearchManager({ cfg, agentId: "orion", purpose: "status" }),
    ) as never as {
      close(): Promise<void>;
      db: { prepare(sql: string): { get(): unknown } };
      status(): { dbPath: string };
    };
    try {
      expect(status.status().dbPath).toBe(mainStatus.dbPath);
      expect(status.db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    } finally {
      await status.close();
    }

    await main.close();
    expect(orion.db.isOpen).toBe(true);
    const afterFirstClose = await orion.search("Alpha");
    expect(afterFirstClose.some((entry) => /Alpha/i.test(entry.snippet))).toBe(true);
  });

  it("does not migrate retained per-agent data into the shared index and restores it on rollback", async () => {
    const rollbackCfg = withoutSystemAgent(createSharedConfig());
    const rollback = requireManager(
      await getMemorySearchManager({ cfg: rollbackCfg, agentId: "main" }),
    ) as never as {
      close(): Promise<void>;
      search(query: string): Promise<Array<{ snippet: string }>>;
      status(): { dbPath: string; files: number };
      sync(params: { reason: string }): Promise<void>;
    };
    const perAgentPath = rollback.status().dbPath;
    await rollback.sync({ reason: "test" });
    expect((await rollback.search("Alpha")).some((entry) => /Alpha/i.test(entry.snippet))).toBe(
      true,
    );
    await rollback.close();

    const sharedCfg = createSharedConfig();
    const shared = requireManager(
      await getMemorySearchManager({ cfg: sharedCfg, agentId: "main" }),
    ) as never as {
      close(): Promise<void>;
      search(query: string): Promise<Array<{ snippet: string }>>;
      status(): { dbPath: string; files: number };
      sync(params: { reason: string }): Promise<void>;
    };
    try {
      expect(shared.status().dbPath).not.toBe(perAgentPath);
      expect(existsSync(perAgentPath)).toBe(true);
      expect(shared.status().files).toBe(0);
    } finally {
      await shared.close();
    }

    const restored = requireManager(
      await getMemorySearchManager({ cfg: rollbackCfg, agentId: "main" }),
    ) as never as {
      search(query: string): Promise<Array<{ snippet: string }>>;
      status(): { dbPath: string };
    };
    expect(restored.status().dbPath).toBe(perAgentPath);
    expect((await restored.search("Alpha")).some((entry) => /Alpha/i.test(entry.snippet))).toBe(
      true,
    );
  });
});
