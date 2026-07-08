import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DashboardStore } from "./store.js";

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("DashboardStore", () => {
  it("seeds workspace.json on first read", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });

      const doc = await store.read();

      expect(doc.tabs[0]).toMatchObject({
        slug: "main",
        title: "Overview",
        createdBy: "system",
      });
      expect(doc.workspaceVersion).toBe(1);
      expect(await readJsonFile(store.workspacePath)).toEqual(doc);
    });
  });

  it("keeps a 20-entry undo ring and restores the newest snapshot", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      await store.read();

      for (let index = 1; index <= 21; index += 1) {
        await store.mutate(
          (draft) => {
            draft.tabs[0]!.title = `Overview ${index}`;
          },
          { actor: "user" },
        );
      }

      const undoFiles = (await fs.readdir(store.undoDir)).toSorted();
      expect(undoFiles).toHaveLength(20);
      const snapshotTitles = await Promise.all(
        undoFiles.map(async (fileName) => {
          const snapshot = (await readJsonFile(path.join(store.undoDir, fileName))) as {
            tabs: Array<{ title: string }>;
          };
          return snapshot.tabs[0]?.title;
        }),
      );
      expect(snapshotTitles).not.toContain("Overview");
      expect(snapshotTitles).toContain("Overview 20");

      const restored = await store.undo();

      expect(restored.tabs[0]?.title).toBe("Overview 20");
      expect(await readJsonFile(store.workspacePath)).toEqual(restored);
    });
  });

  it("rejects oversized mutations without changing the document on disk", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const before = await store.read();

      await expect(
        store.mutate(
          (draft) => {
            draft.tabs[0]!.widgets[0]!.props = { text: "x".repeat(300_000) };
          },
          { actor: "user" },
        ),
      ).rejects.toThrow("workspace document exceeds 256 KB");

      expect(await readJsonFile(store.workspacePath)).toEqual(before);
      expect(fsSync.existsSync(store.undoDir)).toBe(false);
    });
  });

  it("serializes concurrent mutations through the process mutex", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      await store.read();
      const firstGate = deferred();
      const order: string[] = [];

      const first = store.mutate(
        async (draft) => {
          order.push("first:start");
          await firstGate.promise;
          draft.tabs[0]!.title = "First";
          order.push("first:end");
        },
        { actor: "user" },
      );
      await viWaitFor(() => expect(order).toEqual(["first:start"]));

      const second = store.mutate(
        (draft) => {
          order.push("second");
          draft.tabs[0]!.title = `${draft.tabs[0]!.title} Second`;
        },
        { actor: "user" },
      );

      await Promise.resolve();
      expect(order).toEqual(["first:start"]);
      firstGate.resolve();
      await Promise.all([first, second]);

      expect(order).toEqual(["first:start", "first:end", "second"]);
      expect((await store.read()).tabs[0]?.title).toBe("First Second");
    });
  });
});

async function viWaitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
}

describe("DashboardStore.replaceSanitized — approval invariant", () => {
  async function docWithWidget(
    store: DashboardStore,
    status: "pending" | "approved",
  ): Promise<import("./schema.js").WorkspaceDoc> {
    const doc = structuredClone(await store.read());
    doc.widgetsRegistry = {
      "custom-card": { status, createdBy: "agent:evil", approvedBy: "agent:evil" },
    };
    return doc;
  }

  it("downgrades a caller-supplied 'approved' widget to 'pending'", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const { doc } = await store.replaceSanitized(await docWithWidget(store, "approved"), {
        actor: "agent:evil",
      });
      const entry = doc.widgetsRegistry["custom-card"];
      expect(entry?.status).toBe("pending");
      expect(entry?.approvedBy).toBeUndefined();
    });
  });

  it("preserves an already-approved widget across a sanitized replace", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      // Approve it through the trusted primitive first (as the approve verb would).
      await store.replace(await docWithWidget(store, "approved"), { actor: "user" });
      const { doc } = await store.replaceSanitized(await docWithWidget(store, "approved"), {
        actor: "agent:evil",
      });
      expect(doc.widgetsRegistry["custom-card"]?.status).toBe("approved");
    });
  });

  it("leaves the trusted `replace` primitive able to set approved (seed/restore)", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new DashboardStore({ stateDir });
      const { doc } = await store.replace(await docWithWidget(store, "approved"), {
        actor: "user",
      });
      expect(doc.widgetsRegistry["custom-card"]?.status).toBe("approved");
    });
  });
});
