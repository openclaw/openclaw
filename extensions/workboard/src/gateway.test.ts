// Workboard tests cover gateway plugin behavior.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  configureCodefarmProject,
  configureCodefarmProjectRuntime,
  discoverCodefarmReposFromRoots,
  ensureProjectForemanProfile,
  readCodefarmProject,
  registerWorkboardGatewayMethods,
  sendCodefarmProjectTerminalInput,
} from "./gateway.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function codefarmProjectSessionName(repo: string): string {
  const basename =
    repo
      .split("/")
      .findLast(Boolean)
      ?.toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo";
  const digest = createHash("sha256").update(repo).digest("hex").slice(0, 8);
  return `codefarm_${basename}-${digest}`;
}

const itWithTmux = hasTmux() ? it : it.skip;

describe("workboard gateway methods", () => {
  it("registers CRUD methods with read/write scopes", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.create",
      "workboard.cards.update",
      "workboard.cards.move",
      "workboard.cards.delete",
      "workboard.cards.comment",
      "workboard.cards.link",
      "workboard.cards.linkDependency",
      "workboard.cards.proof",
      "workboard.cards.artifact",
      "workboard.cards.claim",
      "workboard.cards.heartbeat",
      "workboard.cards.release",
      "workboard.cards.promote",
      "workboard.cards.reassign",
      "workboard.cards.reclaim",
      "workboard.cards.complete",
      "workboard.cards.block",
      "workboard.cards.unblock",
      "workboard.cards.bulk",
      "workboard.cards.diagnostics",
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.dispatch",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.boards.archive",
      "workboard.boards.delete",
      "workboard.cards.stats",
      "workboard.cards.runs",
      "workboard.cards.specify",
      "workboard.cards.decompose",
      "workboard.notifications.subscribe",
      "workboard.notifications.list",
      "workboard.notifications.delete",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.attachments.list",
      "workboard.cards.attachments.get",
      "workboard.cards.attachments.add",
      "workboard.cards.attachments.delete",
      "workboard.cards.workerLog",
      "workboard.cards.protocolViolation",
      "workboard.cards.archive",
      "workboard.cards.export",
      "codefarm.repos",
      "codefarm.project",
      "codefarm.project.configure",
      "codefarm.project.runtime.set",
      "codefarm.project.terminal.send",
      "codefarm.project.archive",
      "codefarm.project.unarchive",
      "codefarm.list",
      "codefarm.observe",
      "workboard.codefarm.list",
      "workboard.codefarm.observe",
    ]);
    expect(methods.get("workboard.cards.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics.refresh")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.export")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("codefarm.repos")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("codefarm.project")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("codefarm.project.configure")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("codefarm.project.runtime.set")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("codefarm.project.terminal.send")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("codefarm.project.archive")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("codefarm.project.unarchive")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("codefarm.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("codefarm.observe")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.codefarm.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.codefarm.observe")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.create")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.cards.runs")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.attachments.get")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.cards.attachments.add")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.boards.upsert")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.notifications.list")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.events")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.advance")?.opts).toEqual({
      scope: "operator.write",
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
    });

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("generates Project Foreman startup context from the canonical Code Farm project file", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-project-foreman-"));
    const previousHome = process.env.OPENCLAW_HOME;
    try {
      const openclawHome = join(root, "openclaw");
      process.env.OPENCLAW_HOME = openclawHome;

      await ensureProjectForemanProfile(openclawHome);

      const workspace = join(openclawHome, "workspaces", "project-foreman");
      const agents = readFileSync(join(workspace, "AGENTS.md"), "utf8");
      const heartbeat = readFileSync(join(workspace, "Heartbeat.md"), "utf8");

      expect(agents).toContain(".codefarm/project.json");
      expect(heartbeat).toContain(".codefarm/project.json");
      expect(agents).not.toContain("openclaw-project.json");
      expect(heartbeat).not.toContain("openclaw-project.json");
    } finally {
      if (previousHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates stale Project Foreman startup context away from the legacy OpenClaw project file", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-project-foreman-stale-"));
    const previousHome = process.env.OPENCLAW_HOME;
    try {
      const openclawHome = join(root, "openclaw");
      const workspace = join(openclawHome, "workspaces", "project-foreman");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(workspace, "AGENTS.md"),
        "Read the active repo `.codefarm/openclaw-project.json` before steering work.\n",
      );
      writeFileSync(
        join(workspace, "Heartbeat.md"),
        "Read `.gsd/STATE.md` and `.codefarm/openclaw-project.json` when active.\n",
      );
      process.env.OPENCLAW_HOME = openclawHome;

      await ensureProjectForemanProfile(openclawHome);

      const agents = readFileSync(join(workspace, "AGENTS.md"), "utf8");
      const heartbeat = readFileSync(join(workspace, "Heartbeat.md"), "utf8");

      expect(agents).toContain(".codefarm/project.json");
      expect(heartbeat).toContain(".codefarm/project.json");
      expect(agents).not.toContain("openclaw-project.json");
      expect(heartbeat).not.toContain("openclaw-project.json");
    } finally {
      if (previousHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores metadata updates through dedicated card methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Carry metadata" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const commentRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "Waiting on CI" },
      respond: commentRespond,
    } as never);

    expect(commentRespond.mock.calls[0]?.[0]).toBe(true);
    expect(commentRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        metadata: {
          comments: [expect.objectContaining({ body: "Waiting on CI" })],
        },
        events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
      },
    });
  });

  it("validates labels from comma-separated gateway input", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const respond = vi.fn();
    await createHandler?.({
      params: { title: "Check labels", labels: `valid, ${"x".repeat(41)}` },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("dispatches workboard cards when gateway params are omitted", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
    });

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({ respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ cardId: card.id, runId: "run-card" })],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Claim me" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const claimRespond = vi.fn();
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: claimRespond,
    } as never);
    expect(claimRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = vi.fn();
    await methods.get("workboard.cards.heartbeat")?.handler({
      params: { id: cardId, ownerId: "main", note: "alive" },
      respond: heartbeatRespond,
    } as never);
    expect(heartbeatRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [cardId], patch: { priority: "urgent" } },
      respond: bulkRespond,
    } as never);
    expect(bulkRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = vi.fn();
    await methods.get("workboard.cards.complete")?.handler({
      params: { id: cardId, summary: "Operator closed it." },
      respond: completeRespond,
    } as never);
    expect(completeRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        status: "done",
        metadata: {
          comments: expect.arrayContaining([
            expect.objectContaining({ body: "Operator closed it." }),
          ]),
        },
      },
    });

    const blockedCreateRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Block me" },
      respond: blockedCreateRespond,
    } as never);
    const blockedCardId = blockedCreateRespond.mock.calls[0]?.[1]?.card.id;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: blockedCardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);
    const blockRespond = vi.fn();
    await methods.get("workboard.cards.block")?.handler({
      params: { id: blockedCardId, reason: "Operator blocked it." },
      respond: blockRespond,
    } as never);
    expect(blockRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "blocked" },
    });
  });

  it("observes Code Farm jobs through a read-only gateway method", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const observeCodefarm = vi.fn(async () => ({
      schemaVersion: 1,
      jobId: "cf_20260625_001",
      repo: "/Users/me/repo",
      worktree: "/Users/me/repo/.worktrees/codefarm/cf_20260625_001",
      status: "running",
      runtime: "codex",
      branch: "codefarm/cf_20260625_001",
      updatedAt: "2026-06-25T12:00:00Z",
      tmux: {
        available: true,
        enabled: true,
        session: "codefarm_repo-12345678",
        window: "cf_20260625_001",
        pane: "%42",
        attachCommand: "tmux attach -t codefarm_repo-12345678",
        note: null,
      },
      terminal: {
        source: "tmux",
        truncated: false,
        lines: ["worker booted", "running tests"],
      },
      handoff: { taskFile: ".codefarm/jobs/cf_20260625_001/TASK.md", summary: "Run tests" },
      changes: { touchedFiles: ["app/tests/canvas.test.ts"], hasUncommittedChanges: true },
      proof: { proofFile: ".codefarm/jobs/cf_20260625_001/PROOF.json", verdict: null },
    }));
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({
      api,
      store: new WorkboardStore(createMemoryStore()),
      observeCodefarm,
    });

    const respond = vi.fn();
    await methods.get("workboard.codefarm.observe")?.handler({
      params: { repo: "/Users/me/repo", jobId: "cf_20260625_001", lines: 42 },
      respond,
    } as never);

    expect(observeCodefarm).toHaveBeenCalledWith({
      repo: "/Users/me/repo",
      jobId: "cf_20260625_001",
      lines: 42,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      jobId: "cf_20260625_001",
      terminal: { source: "tmux", lines: ["worker booted", "running tests"] },
    });
  });

  it("lists Code Farm jobs through a read-only gateway method", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const listCodefarm = vi.fn(async () => ({
      schemaVersion: 1,
      jobs: [
        {
          id: "cf_20260625_001",
          runtime: "codex-cli",
          observedOrManaged: "managed",
          cwd: "/Users/me/repo",
          worktree: "/Users/me/repo/.worktrees/codefarm/cf_20260625_001",
          taskIntent: "Run focused tests",
          status: "running",
          branch: "codefarm/cf_20260625_001",
          nextAction: "observe",
        },
      ],
    }));
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({
      api,
      store: new WorkboardStore(createMemoryStore()),
      listCodefarm,
    });

    const respond = vi.fn();
    await methods.get("codefarm.list")?.handler({
      params: { repo: "/Users/me/repo" },
      respond,
    } as never);

    expect(listCodefarm).toHaveBeenCalledWith({ repo: "/Users/me/repo" });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      jobs: [expect.objectContaining({ id: "cf_20260625_001", status: "running" })],
    });

    const compatibilityRespond = vi.fn();
    await methods.get("workboard.codefarm.list")?.handler({
      params: { repo: "/Users/me/repo" },
      respond: compatibilityRespond,
    } as never);
    expect(listCodefarm).toHaveBeenCalledTimes(2);
    expect(compatibilityRespond.mock.calls[0]?.[0]).toBe(true);
  });

  it("discovers Code Farm repos from bounded local roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-codefarm-"));
    try {
      const repo = join(root, "agent-space");
      mkdirSync(join(repo, ".codefarm", "jobs", "cf_20260625_001"), { recursive: true });
      mkdirSync(join(repo, ".codefarm", "jobs", "cf_20260625_002"), { recursive: true });
      writeFileSync(
        join(repo, ".codefarm", "index.json"),
        JSON.stringify({
          jobs: [{ id: "cf_20260625_001" }, { id: "cf_20260625_002" }],
        }),
      );
      writeFileSync(
        join(repo, ".codefarm", "jobs", "cf_20260625_001", "JOB.json"),
        JSON.stringify({
          id: "cf_20260625_001",
          status: "running",
          updatedAt: "2026-06-25T12:00:00.000Z",
        }),
      );
      writeFileSync(
        join(repo, ".codefarm", "jobs", "cf_20260625_002", "JOB.json"),
        JSON.stringify({
          id: "cf_20260625_002",
          status: "ready_for_review",
          updatedAt: "2026-06-25T13:00:00.000Z",
        }),
      );

      const payload = await discoverCodefarmReposFromRoots({ roots: [root], maxDepth: 3 });

      expect(payload.repos).toEqual([
        expect.objectContaining({
          repo,
          name: "agent-space",
          totalJobs: 2,
          activeJobs: 1,
          reviewJobs: 1,
          blockedJobs: 0,
          latestUpdatedAt: "2026-06-25T13:00:00.000Z",
          statuses: { running: 1, ready_for_review: 1 },
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides archived Code Farm repos unless archived projects are requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-codefarm-archived-"));
    try {
      const repo = join(root, "agent-space");
      mkdirSync(join(repo, ".codefarm", "jobs", "cf_20260625_001"), { recursive: true });
      writeFileSync(
        join(repo, ".codefarm", "index.json"),
        JSON.stringify({ jobs: [{ id: "cf_20260625_001" }] }),
      );
      writeFileSync(
        join(repo, ".codefarm", "project.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: "agent-space",
          status: "archived",
          archived: true,
          archivedAt: "2026-06-25T14:00:00.000Z",
        }),
      );
      writeFileSync(
        join(repo, ".codefarm", "jobs", "cf_20260625_001", "JOB.json"),
        JSON.stringify({
          id: "cf_20260625_001",
          status: "ready_for_review",
          updatedAt: "2026-06-25T13:00:00.000Z",
        }),
      );

      await expect(discoverCodefarmReposFromRoots({ roots: [root], maxDepth: 3 })).resolves.toEqual(
        expect.objectContaining({ repos: [] }),
      );

      await expect(
        discoverCodefarmReposFromRoots({ roots: [root], maxDepth: 3, includeArchived: true }),
      ).resolves.toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              repo,
              status: "archived",
              archived: true,
              archivedAt: "2026-06-25T14:00:00.000Z",
            }),
          ],
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archives Code Farm projects through write gateway methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const archiveCodefarm = vi.fn(async (params: { repo: string; archived: boolean }) => ({
      schemaVersion: 1,
      repo: params.repo,
      status: params.archived ? "archived" : "active",
      archived: params.archived,
    }));
    const projectCodefarm = vi.fn(async (params: { repo: string }) => ({
      schemaVersion: 1,
      repo: params.repo,
      name: "repo",
      status: archiveCodefarm.mock.calls.at(-1)?.[0]?.archived === true ? "archived" : "active",
      archived: archiveCodefarm.mock.calls.at(-1)?.[0]?.archived === true,
      jobs: {
        totalJobs: 1,
        activeJobs: 0,
        reviewJobs: 1,
        blockedJobs: 0,
        statuses: { ready_for_review: 1 },
      },
      contextFiles: [],
      gsd: { available: false, files: [] },
      projectTerminal: { running: false, persistent: true },
    }));
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({
      api,
      store: new WorkboardStore(createMemoryStore()),
      archiveCodefarm,
      projectCodefarm,
    } as never);

    const archiveRespond = vi.fn();
    await methods.get("codefarm.project.archive")?.handler({
      params: { repo: "/Users/me/repo" },
      respond: archiveRespond,
    } as never);

    expect(archiveCodefarm).toHaveBeenCalledWith({ repo: "/Users/me/repo", archived: true });
    expect(projectCodefarm).toHaveBeenCalledWith({ repo: "/Users/me/repo" });
    expect(archiveRespond.mock.calls[0]?.[0]).toBe(true);
    expect(archiveRespond.mock.calls[0]?.[1]).toMatchObject({
      archived: true,
      jobs: expect.objectContaining({ totalJobs: 1 }),
    });

    const unarchiveRespond = vi.fn();
    await methods.get("codefarm.project.unarchive")?.handler({
      params: { repo: "/Users/me/repo" },
      respond: unarchiveRespond,
    } as never);

    expect(archiveCodefarm).toHaveBeenCalledWith({ repo: "/Users/me/repo", archived: false });
    expect(unarchiveRespond.mock.calls[0]?.[1]).toMatchObject({ archived: false });
  });

  it("sends project terminal input through a write gateway method", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const sendProjectTerminalInputCodefarm = vi.fn(async () => undefined);
    const projectCodefarm = vi.fn(async (params: { repo: string }) => ({
      schemaVersion: 1,
      repo: params.repo,
      name: "repo",
      status: "active",
      archived: false,
      jobs: {
        totalJobs: 0,
        activeJobs: 0,
        reviewJobs: 0,
        blockedJobs: 0,
        statuses: {},
      },
      contextFiles: [],
      gsd: { available: false, files: [] },
      projectTerminal: {
        session: "codefarm_repo-12345678",
        running: true,
        persistent: true,
        terminal: { source: "tmux", truncated: false, lines: ["hello from tmux"] },
      },
    }));
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({
      api,
      store: new WorkboardStore(createMemoryStore()),
      projectCodefarm,
      sendProjectTerminalInputCodefarm,
    } as never);

    const respond = vi.fn();
    await methods.get("codefarm.project.terminal.send")?.handler({
      params: { repo: "/Users/me/repo", input: "echo hello", enter: true },
      respond,
    } as never);

    expect(sendProjectTerminalInputCodefarm).toHaveBeenCalledWith({
      repo: "/Users/me/repo",
      input: "echo hello",
      enter: true,
    });
    expect(projectCodefarm).toHaveBeenCalledWith({ repo: "/Users/me/repo" });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      projectTerminal: expect.objectContaining({
        terminal: expect.objectContaining({ lines: ["hello from tmux"] }),
      }),
    });
  });

  it("configures project context and installs the Project Foreman profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-codefarm-configure-"));
    const previousHome = process.env.OPENCLAW_HOME;
    try {
      const repo = join(root, "agent-space");
      const openclawHome = join(root, "openclaw-home");
      mkdirSync(repo, { recursive: true });
      mkdirSync(openclawHome, { recursive: true });
      writeFileSync(
        join(openclawHome, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: { model: "openai/gpt-5.5" },
            list: [{ id: "main", name: "main" }],
          },
        }),
      );
      process.env.OPENCLAW_HOME = openclawHome;

      const payload = await configureCodefarmProject({
        repo,
        form: {
          projectName: "Agent Space",
          mission: "Make Code Farm observable and project-oriented.",
          currentMilestone: "Persistent project terminals",
          currentSlice: "Project Foreman profile and form",
        },
      });

      expect(payload).toMatchObject({
        repo,
        name: "Agent Space",
        projectForm: {
          projectName: "Agent Space",
          mission: "Make Code Farm observable and project-oriented.",
          currentMilestone: "Persistent project terminals",
          currentSlice: "Project Foreman profile and form",
        },
        profile: {
          id: "project-foreman",
          name: "Project Foreman",
          status: "configured",
        },
      });

      expect(readFileSync(join(repo, ".codefarm", "openclaw-project.json"), "utf8")).toContain(
        "Make Code Farm observable",
      );
      expect(readFileSync(join(repo, ".codefarm", "PROJECT.md"), "utf8")).toContain(
        "Project Foreman",
      );
      expect(readFileSync(join(repo, ".gsd", "STATE.md"), "utf8")).toContain(
        "Persistent project terminals",
      );
      expect(
        readFileSync(join(openclawHome, "workspaces", "project-foreman", "SOUL.md"), "utf8"),
      ).toContain("CodeFarm");
      expect(
        readFileSync(join(openclawHome, "workspaces", "project-foreman", "Tools.md"), "utf8"),
      ).toContain("gsd_execute_task_with_codefarm");
      expect(
        readFileSync(join(openclawHome, "workspaces", "project-foreman", "Identity.md"), "utf8"),
      ).toContain("Project Foreman");
      expect(
        readFileSync(join(openclawHome, "workspaces", "project-foreman", "Heartbeat.md"), "utf8"),
      ).toContain("persistent tmux");
      expect(existsSync(join(openclawHome, "workspaces", "project-foreman", "Bootstrap.md"))).toBe(
        false,
      );
      expect(JSON.parse(readFileSync(join(openclawHome, "openclaw.json"), "utf8"))).toMatchObject({
        agents: {
          list: expect.arrayContaining([
            expect.objectContaining({
              id: "project-foreman",
              identity: { name: "Project Foreman" },
            }),
          ]),
        },
      });

      const runtimePayload = await configureCodefarmProjectRuntime({
        repo,
        runtime: "claude-code",
      });
      expect(runtimePayload).toMatchObject({
        runtime: {
          selected: "claude-code",
          options: [
            expect.objectContaining({ id: "codex-cli" }),
            expect.objectContaining({ id: "claude-code" }),
          ],
        },
      });
      expect(
        JSON.parse(readFileSync(join(repo, ".codefarm", "openclaw-project.json"), "utf8")),
      ).toMatchObject({
        runtime: {
          selected: "claude-code",
        },
      });
      expect(readFileSync(join(repo, ".codefarm", "PROJECT.md"), "utf8")).toContain(
        "Runtime: claude-code",
      );

      await expect(readCodefarmProject({ repo })).resolves.toMatchObject({
        projectForm: expect.objectContaining({ projectName: "Agent Space" }),
        profile: expect.objectContaining({ id: "project-foreman", status: "configured" }),
        runtime: expect.objectContaining({ selected: "claude-code" }),
      });
      await expect(discoverCodefarmReposFromRoots({ roots: [root], maxDepth: 1 })).resolves.toEqual(
        expect.objectContaining({
          repos: [
            expect.objectContaining({
              repo,
              name: "Agent Space",
              totalJobs: 0,
            }),
          ],
        }),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads project context, GSD state, and project terminal identity for a Code Farm repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-codefarm-project-"));
    try {
      const repo = join(root, "agent-space");
      mkdirSync(join(repo, ".codefarm", "jobs", "cf_20260625_001"), { recursive: true });
      mkdirSync(join(repo, ".gsd"), { recursive: true });
      writeFileSync(
        join(repo, ".codefarm", "index.json"),
        JSON.stringify({ jobs: [{ id: "cf_20260625_001" }] }),
      );
      writeFileSync(
        join(repo, ".codefarm", "jobs", "cf_20260625_001", "JOB.json"),
        JSON.stringify({
          id: "cf_20260625_001",
          status: "running",
          updatedAt: "2026-06-25T12:00:00.000Z",
        }),
      );
      writeFileSync(join(repo, "AGENTS.md"), "# Agent Space\n\nKeep pool work bounded.");
      writeFileSync(join(repo, ".gsd", "PROJECT.md"), "# OTG Prewarm Pool");
      writeFileSync(join(repo, ".gsd", "STATE.md"), "# State\n\nMilestone: S02 proof.");

      const payload = await readCodefarmProject({ repo });

      expect(payload).toMatchObject({
        schemaVersion: 1,
        repo,
        name: "agent-space",
        jobs: expect.objectContaining({
          totalJobs: 1,
          activeJobs: 1,
          statuses: { running: 1 },
        }),
        projectTerminal: expect.objectContaining({
          session: expect.stringMatching(/^codefarm_agent-space-[a-f0-9]{8}$/),
          attachCommand: expect.stringMatching(/^tmux attach -t codefarm_agent-space-[a-f0-9]{8}$/),
        }),
      });
      expect(payload.contextFiles).toEqual([
        expect.objectContaining({
          path: "AGENTS.md",
          kind: "agent_context",
          content: expect.stringContaining("Keep pool work bounded."),
        }),
      ]);
      expect(payload.gsd).toEqual(
        expect.objectContaining({
          available: true,
          files: expect.arrayContaining([
            expect.objectContaining({ path: ".gsd/PROJECT.md" }),
            expect.objectContaining({
              path: ".gsd/STATE.md",
              content: expect.stringContaining("Milestone: S02 proof."),
            }),
          ]),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithTmux("captures persistent project tmux scrollback for Code Farm repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-codefarm-project-terminal-"));
    const repo = join(root, "agent-space");
    const session = codefarmProjectSessionName(repo);
    try {
      mkdirSync(join(repo, ".codefarm"), { recursive: true });
      execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", "project", "-c", repo, "sh"]);
      execFileSync("tmux", [
        "send-keys",
        "-t",
        `${session}:project.0`,
        "-l",
        "--",
        "printf 'project booted\\n'",
      ]);
      execFileSync("tmux", ["send-keys", "-t", `${session}:project.0`, "Enter"]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const payload = await readCodefarmProject({ repo });

      expect(payload.projectTerminal).toEqual(
        expect.objectContaining({
          session,
          running: true,
          terminal: expect.objectContaining({
            source: "tmux",
            lines: expect.arrayContaining([expect.stringContaining("project booted")]),
          }),
        }),
      );
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      } catch {
        // Session may not exist if tmux failed before creation.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithTmux("sends input to the persistent project tmux session", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-codefarm-project-terminal-send-"));
    const repo = join(root, "agent-space");
    const session = codefarmProjectSessionName(repo);
    try {
      mkdirSync(join(repo, ".codefarm"), { recursive: true });
      execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", "project", "-c", repo, "sh"]);

      await sendCodefarmProjectTerminalInput({
        repo,
        input: "printf 'interactive hello\\n'",
        enter: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const payload = await readCodefarmProject({ repo });

      expect(payload.projectTerminal.terminal?.lines.join("\n")).toContain("interactive hello");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      } catch {
        // Session may not exist if tmux failed before creation.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe Code Farm observe parameters before invoking the CLI", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const observeCodefarm = vi.fn();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({
      api,
      store: new WorkboardStore(createMemoryStore()),
      observeCodefarm,
    });

    const respond = vi.fn();
    await methods.get("codefarm.observe")?.handler({
      params: { repo: "/Users/me/repo", jobId: "cf_20260625_001;rm -rf /", lines: 5000 },
      respond,
    } as never);

    expect(observeCodefarm).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toContain("jobId");
  });
});
