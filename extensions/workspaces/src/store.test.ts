import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE } from "./default-workspace.js";
import { validateWorkspaceDoc, type WorkspaceDoc } from "./schema.js";
import { WorkspaceStore } from "./store.js";

async function withStore<T>(run: (store: WorkspaceStore) => Promise<T> | T): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
  const store = new WorkspaceStore({ stateDir });
  try {
    return await run(store);
  } finally {
    store.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

/** A doc carrying one scaffolded (pending) custom widget in the registry. */
function docWithPendingWidget(store: WorkspaceStore): WorkspaceDoc {
  return store.mutate(
    (draft) => {
      draft.widgetsRegistry.chart = { status: "pending", createdBy: "agent:finance" };
    },
    { actor: "agent:finance" },
  ).doc;
}

describe("WorkspaceStore", () => {
  it("seeds the default workspace on first read", async () => {
    await withStore((store) => {
      const doc = store.read();

      expect(doc).toMatchObject({
        workspaceId: "default",
        tabs: [{ id: "main", slug: "main", revision: 1, title: "Overview", createdBy: "system" }],
      });
      expect(doc.workspaceVersion).toBe(1);
      // A second read hits the single-slot cache and must agree with the DB.
      expect(store.read()).toEqual(doc);
    });
  });

  it("increments only tabs whose persisted content changed", async () => {
    await withStore((store) => {
      store.mutate(
        (draft) => {
          draft.tabs.push({
            id: "second",
            revision: 999,
            slug: "second",
            title: "Second",
            hidden: false,
            createdBy: "user",
            widgets: [],
          });
          draft.prefs.tabOrder.push("second");
        },
        { actor: "user" },
      );
      expect(store.read().tabs.map((tab) => [tab.id, tab.revision])).toEqual([
        ["main", 1],
        ["second", 1],
      ]);

      const changed = store.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Changed";
          draft.tabs[0]!.revision = 800;
          draft.tabs[1]!.revision = 700;
        },
        { actor: "user" },
      ).doc;

      expect(changed.tabs.map((tab) => [tab.id, tab.revision])).toEqual([
        ["main", 2],
        ["second", 1],
      ]);
    });
  });

  it("does not increment a tab revision for unrelated workspace state", async () => {
    await withStore((store) => {
      const changed = store.mutate(
        (draft) => {
          draft.widgetsRegistry.chart = { status: "pending", createdBy: "agent:finance" };
        },
        { actor: "agent:finance" },
      ).doc;

      expect(changed.tabs[0]?.revision).toBe(1);
    });
  });

  it("ignores forged revisions on whole-document replacement", async () => {
    await withStore((store) => {
      const unchanged = structuredClone(store.read());
      unchanged.tabs[0]!.revision = 900;
      expect(store.replace(unchanged, { actor: "user" }).doc.tabs[0]?.revision).toBe(1);

      const changed = structuredClone(store.read());
      changed.tabs[0]!.revision = 800;
      changed.tabs[0]!.title = "Replacement";
      expect(store.replace(changed, { actor: "user" }).doc.tabs[0]?.revision).toBe(2);
    });
  });

  it("partitions workspace documents and undo history by isolation domain", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-domains-"));
    const first = new WorkspaceStore({ stateDir, isolationDomainId: "domain-1" });
    const second = new WorkspaceStore({ stateDir, isolationDomainId: "domain-2" });
    try {
      first.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Domain One";
        },
        { actor: "user" },
      );
      second.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Domain Two";
        },
        { actor: "user" },
      );

      expect(first.read().tabs[0]?.title).toBe("Domain One");
      expect(second.read().tabs[0]?.title).toBe("Domain Two");
      expect(first.undo().tabs[0]?.title).toBe("Overview");
      expect(second.read().tabs[0]?.title).toBe("Domain Two");
    } finally {
      first.close();
      second.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("migrates the singleton v1 database into the default isolation domain", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-legacy-"));
    const workspaceDir = path.join(stateDir, "workspaces");
    const dbPath = path.join(workspaceDir, "workspaces.sqlite");
    await fs.mkdir(workspaceDir, { recursive: true });
    const legacy = structuredClone(DEFAULT_WORKSPACE) as unknown as {
      schemaVersion: number;
      workspaceId?: string;
      tabs: Array<{ id?: string; revision?: number }>;
    };
    legacy.schemaVersion = 1;
    delete legacy.workspaceId;
    for (const tab of legacy.tabs) {
      delete tab.id;
      delete tab.revision;
    }
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE workspace (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        doc TEXT NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE undo (
        version INTEGER PRIMARY KEY,
        doc TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO workspace (id, version, doc, updated_ms) VALUES (1, 7, ?, 1)").run(
      JSON.stringify({ ...legacy, workspaceVersion: 7 }),
    );
    db.close();

    const store = new WorkspaceStore({ stateDir });
    try {
      const doc = store.read();
      expect(doc).toMatchObject({
        schemaVersion: 2,
        workspaceId: "default",
        workspaceVersion: 7,
        tabs: [{ id: "main", slug: "main" }],
      });
    } finally {
      store.close();
    }

    const inspected = new DatabaseSync(dbPath);
    try {
      expect(inspected.prepare("PRAGMA table_info(workspace)").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "isolation_domain_id" }),
          expect.objectContaining({ name: "workspace_id" }),
        ]),
      );
      const row = inspected
        .prepare(
          "SELECT isolation_domain_id, workspace_id, doc FROM workspace WHERE isolation_domain_id = ?",
        )
        .get("default") as { isolation_domain_id: string; workspace_id: string; doc: string };
      expect(row).toMatchObject({ isolation_domain_id: "default", workspace_id: "default" });
      expect(JSON.parse(row.doc)).toMatchObject({ schemaVersion: 2, workspaceId: "default" });
    } finally {
      inspected.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects direct mutation of stable resource ids", async () => {
    await withStore((store) => {
      const before = store.read();

      expect(() =>
        store.mutate(
          (draft) => {
            draft.workspaceId = "other";
          },
          { actor: "user" },
        ),
      ).toThrow("workspaceId is immutable");
      expect(() =>
        store.mutate(
          (draft) => {
            draft.tabs[0]!.id = "other";
          },
          { actor: "user" },
        ),
      ).toThrow("tab id is immutable");
      expect(store.read()).toEqual(before);
    });
  });

  it("replace preserves existing stable ids when a tab keeps its slug", async () => {
    await withStore((store) => {
      const incoming = structuredClone(store.read());
      incoming.workspaceId = "forged";
      incoming.tabs[0]!.id = "forged-tab";

      const { doc } = store.replace(incoming, { actor: "user" });

      expect(doc.workspaceId).toBe("default");
      expect(doc.tabs[0]?.id).toBe("main");
    });
  });

  it("canonicalizes legacy v1 replacement input before reconciling resource ids", async () => {
    await withStore((store) => {
      const legacy = structuredClone(store.read()) as unknown as {
        schemaVersion: number;
        workspaceId?: string;
        tabs: Array<{ id?: string; revision?: number; title: string }>;
      };
      legacy.schemaVersion = 1;
      delete legacy.workspaceId;
      for (const tab of legacy.tabs) {
        delete tab.id;
        delete tab.revision;
      }
      legacy.tabs[0]!.title = "Imported Legacy Layout";

      const { doc } = store.replace(legacy, { actor: "user" });

      expect(doc).toMatchObject({
        schemaVersion: 2,
        workspaceId: "default",
        tabs: [{ id: "main", slug: "main", title: "Imported Legacy Layout" }],
      });
    });
  });

  it("keeps a 20-entry undo ring and restores the newest snapshot as a NEW version", async () => {
    await withStore((store) => {
      store.read();
      for (let index = 1; index <= 21; index += 1) {
        store.mutate(
          (draft) => {
            draft.tabs[0]!.title = `Overview ${index}`;
          },
          { actor: "user" },
        );
      }
      const beforeUndo = store.read();

      const restored = store.undo();

      expect(restored.tabs[0]?.title).toBe("Overview 20");
      // Monotonic: connected UIs refetch only on a strictly newer version, so an
      // undo that rewound `workspaceVersion` would never reach an open browser.
      expect(restored.workspaceVersion).toBe(beforeUndo.workspaceVersion + 1);
      expect(store.read()).toEqual(restored);
    });
  });

  it("restores a deleted tab under a fresh resource id", async () => {
    await withStore((store) => {
      store.mutate(
        (draft) => {
          draft.tabs.push({
            id: "finance",
            revision: 1,
            slug: "finance",
            title: "Finance",
            hidden: false,
            createdBy: "user",
            widgets: [],
          });
          draft.prefs.tabOrder.push("finance");
        },
        { actor: "user" },
      );
      store.mutate(
        (draft) => {
          draft.tabs = draft.tabs.filter((tab) => tab.id !== "finance");
          draft.prefs.tabOrder = draft.prefs.tabOrder.filter((slug) => slug !== "finance");
        },
        { actor: "user" },
      );

      const restored = store.undo();
      const finance = restored.tabs.find((tab) => tab.slug === "finance");
      expect(finance?.id).not.toBe("finance");
      expect(finance?.revision).toBe(1);
    });
  });

  it("evicts the oldest undo snapshot past the ring size", async () => {
    await withStore((store) => {
      store.read();
      for (let index = 1; index <= 25; index += 1) {
        store.mutate(
          (draft) => {
            draft.tabs[0]!.title = `Overview ${index}`;
          },
          { actor: "user" },
        );
      }

      // 20 snapshots survive, so 20 undos succeed and the 21st has nothing left.
      for (let index = 0; index < 20; index += 1) {
        store.undo();
      }
      expect(() => store.undo()).toThrow("no workspace undo snapshot available");
    });
  });

  it("rolls back an oversized mutation, leaving no partial write and no undo entry", async () => {
    await withStore((store) => {
      const before = store.read();

      expect(() =>
        store.mutate(
          (draft) => {
            draft.tabs[0]!.widgets[0]!.props = { text: "x".repeat(300_000) };
          },
          { actor: "user" },
        ),
      ).toThrow("workspace document exceeds 256 KB");

      expect(store.read()).toEqual(before);
      expect(() => store.undo()).toThrow("no workspace undo snapshot available");
    });
  });

  it("rolls back an invalid mutation without bumping the version", async () => {
    await withStore((store) => {
      const before = store.read();

      expect(() =>
        store.mutate(
          (draft) => {
            draft.tabs[0]!.slug = "Not A Slug";
          },
          { actor: "user" },
        ),
      ).toThrow(/slug is invalid/);

      expect(store.read().workspaceVersion).toBe(before.workspaceVersion);
    });
  });

  it("replace cannot self-approve a pending custom widget", async () => {
    await withStore((store) => {
      const doc = docWithPendingWidget(store);

      // The attack: submit a whole document that already marks the widget approved.
      const forged = validateWorkspaceDoc({
        ...doc,
        widgetsRegistry: {
          chart: { status: "approved", createdBy: "agent:finance", approvedBy: "user" },
        },
      });
      const result = store.replace(forged, { actor: "agent:finance" });

      expect(result.doc.widgetsRegistry.chart).toEqual({
        status: "pending",
        createdBy: "agent:finance",
      });
      expect(store.widgetStatus("chart")).toBe("pending");
    });
  });

  it("replace preserves registry decisions omitted by the incoming document", async () => {
    await withStore((store) => {
      const doc = docWithPendingWidget(store);
      const replacement = validateWorkspaceDoc({ ...doc, widgetsRegistry: {} });

      const result = store.replace(replacement, { actor: "agent:finance" });

      expect(result.doc.widgetsRegistry.chart).toEqual({
        status: "pending",
        createdBy: "agent:finance",
      });
    });
  });

  it("does not restore a revoked widget approval through undo", async () => {
    await withStore((store) => {
      docWithPendingWidget(store);
      store.mutate(
        (draft) => {
          draft.widgetsRegistry.chart = {
            status: "approved",
            createdBy: "agent:finance",
            approvedBy: "user",
            approvedAt: "2026-07-11T00:00:00.000Z",
            approvedFiles: { "index.html": "a".repeat(64) },
          };
        },
        { actor: "user" },
      );
      store.mutate(
        (draft) => {
          draft.widgetsRegistry.chart = {
            status: "rejected",
            createdBy: "agent:finance",
            approvedBy: "user",
            approvedAt: "2026-07-11T00:01:00.000Z",
          };
        },
        { actor: "user" },
      );

      const restored = store.undo();

      expect(restored.widgetsRegistry.chart).toMatchObject({ status: "rejected" });
      expect(restored.widgetsRegistry.chart?.approvedFiles).toBeUndefined();
    });
  });

  it("replace cannot forge provenance on new or existing entities", async () => {
    await withStore((store) => {
      const seeded = store.read();
      const forged = validateWorkspaceDoc({
        ...seeded,
        tabs: [
          // Existing system tab, relabelled as agent-authored.
          { ...seeded.tabs[0]!, createdBy: "agent:evil" },
          {
            id: "new",
            revision: 1,
            slug: "new",
            title: "New",
            hidden: false,
            // Agent-created tab, relabelled as human-authored.
            createdBy: "user",
            widgets: [
              {
                id: "w1",
                kind: "builtin:markdown",
                grid: { x: 0, y: 0, w: 4, h: 2 },
                collapsed: false,
                hidden: false,
                createdBy: "user",
              },
            ],
          },
        ],
        prefs: { tabOrder: ["main", "new"] },
      });

      const { doc } = store.replace(forged, { actor: "agent:evil" });

      expect(doc.tabs[0]?.createdBy).toBe("system");
      expect(doc.tabs[1]?.createdBy).toBe("agent:evil");
      expect(doc.tabs[1]?.widgets[0]?.createdBy).toBe("agent:evil");
    });
  });

  it("replace cannot mint a registry entry for a widget that was never scaffolded", async () => {
    await withStore((store) => {
      const seeded = store.read();
      // The attack: invent a registry name, get an operator to approve it, then
      // write the code afterwards. Names that were never scaffolded are dropped.
      const forged = validateWorkspaceDoc({
        ...seeded,
        widgetsRegistry: { evil: { status: "pending", createdBy: "agent:evil" } },
      });

      const { doc } = store.replace(forged, { actor: "agent:evil" });

      expect(doc.widgetsRegistry).toEqual({});
      expect(store.widgetStatus("evil")).toBeNull();
    });
  });

  it("widgetStatus reports null for an unknown widget", async () => {
    await withStore((store) => {
      store.read();
      expect(store.widgetStatus("nope")).toBeNull();
    });
  });
});
