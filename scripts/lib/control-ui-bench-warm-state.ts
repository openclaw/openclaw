import type { Page } from "playwright";
import type { SidebarSnapshotModel } from "../../ui/src/components/sidebar-snapshot-model.ts";
import type { ChatSessionSnapshot } from "../../ui/src/pages/chat/session-message-cache.ts";
import type { SessionSnapshotStore } from "../../ui/src/pages/chat/session-snapshot-store.ts";

type StoredTranscript = {
  sessionKey: string;
  projectionVersion: number;
  snapshot: ChatSessionSnapshot;
};
type StoredSidebar = { sessionKey: string; model: SidebarSnapshotModel };

/** Runs in the page; the application owns trimming and serializing both projections. */
export async function persistColdLoadWarmState(input: {
  sessionKey: string;
  sidebarView: "sessions" | "online";
}) {
  const pane = document.querySelector(".chat-pane-cache__pane--active");
  const store: SessionSnapshotStore | undefined = pane
    ? Reflect.get(pane, "sessionSnapshotStore")
    : undefined;
  const cache: Map<string, { snapshot: ChatSessionSnapshot }> | undefined = pane
    ? Reflect.get(pane, "chatMessagesBySession")
    : undefined;
  const entry = cache && [...cache].find(([key]) => key.endsWith(`\u0000${input.sessionKey}`));
  if (!store || !entry) throw new Error("Warm reload requires the active transcript cache owner");
  store.write(entry[0], { ...entry[1].snapshot });
  await store.flush();
  const result = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const database = await result(indexedDB.open("openclaw-chat-snapshots"));
  try {
    const transaction = database.transaction(["snapshots", "sidebarSnapshots", "snapshotMetadata"]);
    const [snapshots, sidebars, metadata]: [StoredTranscript[], StoredSidebar[], unknown[]] =
      await Promise.all([
        result(transaction.objectStore("snapshots").getAll()),
        result(transaction.objectStore("sidebarSnapshots").getAll()),
        result(transaction.objectStore("snapshotMetadata").getAll()),
      ]);
    const record = snapshots.find((value) => value.sessionKey === entry[0]);
    const sidebar = sidebars.find((value) =>
      value.sessionKey.startsWith(`${entry[0].split("\u0000")[0]}\u0000sidebar:`),
    );
    if (!record || !sidebar || sidebar.model.navigationView !== input.sidebarView) {
      throw new Error(
        "Warm reload requires the selected transcript and sidebar view persisted in IndexedDB",
      );
    }
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    return {
      storage: {
        records: { snapshots, sidebarSnapshots: sidebars, snapshotMetadata: metadata },
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      },
      bytes: bytes(record),
      messages: record.snapshot.messages.length,
      databaseVersion: database.version,
      projectionVersion: record.projectionVersion,
      sidebarBytes: bytes(sidebar),
      sidebarView: sidebar.model.navigationView,
      sidebarSessions: sidebar.model.sessions.length,
      sidebarPeople: sidebar.model.onlineUsers.length,
    };
  } finally {
    database.close();
  }
}

export async function restoreColdLoadWarmState(
  page: Page,
  storage: Awaited<ReturnType<typeof persistColdLoadWarmState>>["storage"],
) {
  const url = page.url();
  const resetUrl = new URL("/__control-ui-bench-warm-reset__", url).href;
  await page.route(resetUrl, (route) => route.fulfill({ body: "", contentType: "text/html" }));
  // Unload pagehide writers first; Playwright setStorageState would also clear the HTTP cache.
  await page.mainFrame().goto(resetUrl);
  await page.unroute(resetUrl);
  await page.evaluate("globalThis.__name = (fn) => fn");
  await page.evaluate(
    async ({ storage, url }) => {
      const databases: Record<string, Record<string, unknown[]>> = {
        "openclaw-chat-snapshots": storage.records,
      };
      if ((await indexedDB.databases()).some(({ name }) => name === "openclaw-control-ui")) {
        databases["openclaw-control-ui"] = { composerDrafts: [] };
      }
      for (const [name, records] of Object.entries(databases)) {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const transaction = database.transaction(Object.keys(records), "readwrite");
          const complete = new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error);
          });
          for (const [name, rows] of Object.entries(records)) {
            const store = transaction.objectStore(name);
            store.clear();
            for (const row of rows) store.put(row);
          }
          await complete;
        } finally {
          database.close();
        }
      }
      for (const [target, entries] of [
        [localStorage, storage.local],
        [sessionStorage, storage.session],
      ] as const) {
        target.clear();
        for (const [key, value] of entries) target.setItem(key, value);
      }
      history.replaceState(null, "", url);
    },
    { storage, url },
  );
}
