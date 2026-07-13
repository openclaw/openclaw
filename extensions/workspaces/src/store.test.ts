import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
  it("persists size-capped widget state in SQLite with monotonic versions", async () => {
    await withStore((store) => {
      expect(store.readWidgetState("cost-today")).toBeNull();

      expect(store.writeWidgetState("cost-today", { text: "hello" })).toMatchObject({ version: 1 });
      expect(store.readWidgetState("cost-today")).toMatchObject({
        state: { text: "hello" },
        version: 1,
        updatedAt: expect.any(String),
      });

      expect(
        store.writeWidgetState("cost-today", { text: "updated" }, { expectedVersion: 1 }),
      ).toMatchObject({ version: 2 });
      expect(store.readWidgetState("cost-today")).toMatchObject({
        state: { text: "updated" },
        version: 2,
      });
    });
  });

  it("keeps widget state after the store is reopened", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-reopen-"));
    try {
      const first = new WorkspaceStore({ stateDir });
      first.writeWidgetState("cost-today", { text: "durable" });
      first.close();

      const reopened = new WorkspaceStore({ stateDir });
      try {
        expect(reopened.readWidgetState("cost-today")).toMatchObject({
          state: { text: "durable" },
          version: 1,
        });
      } finally {
        reopened.close();
      }
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects stale, invalid, and oversized widget state without changing prior state", async () => {
    await withStore((store) => {
      store.writeWidgetState("cost-today", { text: "safe" }, { expectedVersion: 0 });

      expect(() =>
        store.writeWidgetState("cost-today", { text: "stale" }, { expectedVersion: 0 }),
      ).toThrow("widget state version conflict: expected 0, found 1");
      expect(() => store.writeWidgetState("../escape", { nope: true })).toThrow(
        "widget id is invalid",
      );
      expect(() => store.writeWidgetState("cost-today", { text: "x".repeat(70 * 1024) })).toThrow(
        "widget state exceeds 64 KB",
      );
      expect(() => store.writeWidgetState("cost-today", { bad: undefined } as never)).toThrow(
        "widget state must be valid JSON",
      );

      expect(store.readWidgetState("cost-today")).toMatchObject({
        state: { text: "safe" },
        version: 1,
      });
    });
  });

  it("deletes state when a widget is removed or replaced with a different kind", async () => {
    await withStore((store) => {
      store.writeWidgetState("cost-today", { text: "private" });
      store.mutate(
        (draft) => {
          draft.tabs[0]!.widgets = draft.tabs[0]!.widgets.filter(
            (widget) => widget.id !== "cost-today",
          );
        },
        { actor: "user" },
      );
      expect(store.readWidgetState("cost-today")).toBeNull();
      expect(() => store.writeWidgetState("cost-today", { text: "orphan" })).toThrow(
        "workspace widget not found",
      );

      store.mutate(
        (draft) => {
          draft.tabs[0]!.widgets.push({
            id: "cost-today",
            kind: "builtin:markdown",
            title: "Replacement",
            grid: { x: 0, y: 0, w: 4, h: 2 },
            collapsed: false,
            hidden: false,
            createdBy: "user",
          });
        },
        { actor: "user" },
      );
      expect(store.readWidgetState("cost-today")).toBeNull();
      expect(
        store.writeWidgetState("cost-today", { text: "fresh" }, { expectedVersion: 0 }),
      ).toEqual({
        version: 1,
      });
    });
  });

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
