import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { validateWorkspaceDoc, type WorkspaceDoc } from "./schema.js";
import { WorkspaceStore } from "./store.js";

async function withStore<T>(
  run: (store: WorkspaceStore, stateDir: string) => Promise<T> | T,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
  const store = new WorkspaceStore({ stateDir });
  try {
    return await run(store, stateDir);
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

      expect(doc.tabs[0]).toMatchObject({ slug: "main", title: "Overview", createdBy: "system" });
      expect(doc.workspaceVersion).toBe(1);
      // A second read hits the single-slot cache and must agree with the DB.
      expect(store.read()).toEqual(doc);
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

  it("lists undo history newest-first as metadata without consuming snapshots", async () => {
    await withStore((store) => {
      store.read();
      for (let index = 1; index <= 3; index += 1) {
        store.mutate(
          (draft) => {
            draft.tabs[0]!.title = `Overview ${index}`;
          },
          { actor: "user" },
        );
      }

      const history = store.listHistory();

      expect(history.map((entry) => entry.version)).toEqual([3, 2, 1]);
      for (const entry of history) {
        expect(entry.bytes).toBeGreaterThan(0);
        expect(new Date(entry.savedAt).toISOString()).toBe(entry.savedAt);
        expect(Object.keys(entry).toSorted()).toEqual(["bytes", "savedAt", "version"]);
      }
      // Read-only history inspection must leave the newest undo available.
      expect(store.undo().tabs[0]?.title).toBe("Overview 2");
    });
  });

  it("returns the exact snapshot document for its own workspace version", async () => {
    await withStore((store) => {
      store.read();
      store.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Renamed";
        },
        { actor: "user" },
      );
      store.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Renamed again";
        },
        { actor: "user" },
      );

      const snapshot = store.getHistorySnapshot(2);
      expect(snapshot.workspaceVersion).toBe(2);
      expect(snapshot.tabs[0]?.title).toBe("Renamed");
      expect(() => store.getHistorySnapshot(999)).toThrow(
        "no workspace history snapshot for version 999",
      );
    });
  });

  it("restores the exact previewed snapshot after a concurrent workspace write", async () => {
    await withStore((store) => {
      store.read();
      for (const title of ["Previewed", "Current"]) {
        store.mutate(
          (draft) => {
            draft.tabs[0]!.title = title;
          },
          { actor: "user" },
        );
      }
      const previewed = store.getHistorySnapshot(2);
      expect(previewed.tabs[0]?.title).toBe("Previewed");

      store.mutate(
        (draft) => {
          draft.tabs[0]!.title = "Concurrent";
        },
        { actor: "agent:main" },
      );
      const beforeRestore = store.read();

      const restored = store.restoreHistorySnapshot(previewed.workspaceVersion);

      expect(restored.tabs[0]?.title).toBe("Previewed");
      expect(restored.workspaceVersion).toBe(beforeRestore.workspaceVersion + 1);
      expect(store.getHistorySnapshot(beforeRestore.workspaceVersion).tabs[0]?.title).toBe(
        "Concurrent",
      );
      expect(store.getHistorySnapshot(3).tabs[0]?.title).toBe("Current");
      expect(() => store.getHistorySnapshot(2)).toThrow(
        "no workspace history snapshot for version 2",
      );
      expect(store.undo().tabs[0]?.title).toBe("Concurrent");
    });
  });

  it("isolates a corrupt newest row across history list, get, and restore", async () => {
    await withStore((store, stateDir) => {
      store.read();
      for (const title of ["One", "Two", "Three"]) {
        store.mutate(
          (draft) => {
            draft.tabs[0]!.title = title;
          },
          { actor: "user" },
        );
      }
      const database = new DatabaseSync(path.join(stateDir, "workspaces", "workspaces.sqlite"));
      try {
        database
          .prepare("UPDATE undo SET doc = ? WHERE version = (SELECT MAX(version) FROM undo)")
          .run("{broken");
      } finally {
        database.close();
      }

      expect(store.listHistory().map((entry) => entry.version)).toEqual([2, 1]);
      expect(store.getHistorySnapshot(2).tabs[0]?.title).toBe("One");
      const beforeRestore = store.read();

      const restored = store.restoreHistorySnapshot(2);

      expect(restored.tabs[0]?.title).toBe("One");
      expect(restored.workspaceVersion).toBe(beforeRestore.workspaceVersion + 1);
    });
  });

  it("returns empty history before the first mutation", async () => {
    await withStore((store) => {
      store.read();
      expect(store.listHistory()).toEqual([]);
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
