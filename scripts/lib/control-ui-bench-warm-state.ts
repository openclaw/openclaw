import type { Page } from "playwright";
// Only these structural ports cross Playwright's serialized browser boundary.
type ChatSessionSnapshot = { messages: unknown[] };
type SessionSnapshotStore = {
  write(key: string, snapshot: ChatSessionSnapshot): void;
  flush(): Promise<void>;
};

type SidebarSnapshotModel = {
  navigationView: string;
  onlineUsers: unknown[];
  roster?: { result: { sessions: Array<{ key: string }> } } | null;
};

type StoredTranscript = {
  sessionKey: string;
  projectionVersion: number;
  snapshot: ChatSessionSnapshot;
};
type StoredSidebar = { sessionKey: string; model: SidebarSnapshotModel };

export async function persistColdLoadWarmState(input: {
  sessionKey: string;
  sidebarView: "sessions" | "online";
  offRosterSession?: boolean;
  rowFacts?: boolean;
}) {
  const pane = document.querySelector(".chat-pane-cache__pane--active");
  const store: SessionSnapshotStore | undefined = pane
    ? Reflect.get(pane, "sessionSnapshotStore")
    : undefined;
  const cache: Map<string, { snapshot: ChatSessionSnapshot }> | undefined = pane
    ? Reflect.get(pane, "chatMessagesBySession")
    : undefined;
  const entry = cache && [...cache].find(([key]) => key.endsWith(`\u0000${input.sessionKey}`));
  if (!store || !entry) {
    throw new Error("Warm reload requires the active transcript cache owner");
  }
  store.write(entry[0], { ...entry[1].snapshot });
  await store.flush();
  const result = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Snapshot request failed")),
      );
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
    const rosterContainsSession =
      sidebar.model.roster?.result.sessions.some((row) => row.key === input.sessionKey) ?? false;
    if (input.offRosterSession && rosterContainsSession) {
      throw new Error("Off-roster measurement found the selected session in the persisted roster");
    }
    return {
      rosterContainsSession,
      storage: {
        records: { snapshots, sidebarSnapshots: sidebars, snapshotMetadata: metadata },
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      },
      messages: record.snapshot.messages.length,
      ...(input.rowFacts
        ? { snapshotBytes: new TextEncoder().encode(JSON.stringify(record)).byteLength }
        : {}),
      databaseVersion: database.version,
      projectionVersion: record.projectionVersion,
      sidebarView: sidebar.model.navigationView,
      sidebarPeople: sidebar.model.onlineUsers.length,
      sidebarBytes: new TextEncoder().encode(JSON.stringify(sidebar.model)).byteLength,
    };
  } finally {
    database.close();
  }
}

export async function restoreColdLoadWarmState(
  page: Page,
  storage: Awaited<ReturnType<typeof persistColdLoadWarmState>>["storage"],
  leavingStorage?: typeof storage,
) {
  const url = page.url();
  const resetUrl = new URL("/__control-ui-bench-warm-reset__", url).href;
  await page.route(resetUrl, (route) => route.fulfill({ body: "", contentType: "text/html" }));
  // Unload pagehide writers first; Playwright setStorageState would also clear the HTTP cache.
  await page.mainFrame().goto(resetUrl);
  await page.unroute(resetUrl);
  if (leavingStorage) {
    // Priming captures the leaving variant's native exit writes; repeats keep frozen inputs.
    const exit = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    leavingStorage.local = exit.local;
    leavingStorage.session = exit.session;
  }
  await page.evaluate(
    async ({ storage: saved, url: deepLink }) => {
      const databases: Record<string, Record<string, unknown[]>> = {
        "openclaw-chat-snapshots": saved.records,
      };
      if ((await indexedDB.databases()).some(({ name }) => name === "openclaw-control-ui")) {
        databases["openclaw-control-ui"] = { composerDrafts: [] };
      }
      for (const [name, records] of Object.entries(databases)) {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("Snapshot request failed")),
          );
        });
        try {
          const transaction = database.transaction(Object.keys(records), "readwrite");
          const complete = new Promise<void>((resolve, reject) => {
            transaction.addEventListener("complete", () => resolve());
            transaction.addEventListener("abort", () =>
              reject(transaction.error ?? new Error("Snapshot write aborted")),
            );
          });
          for (const [storeName, rows] of Object.entries(records)) {
            const store = transaction.objectStore(storeName);
            store.clear();
            for (const row of rows) {
              store.put(row);
            }
          }
          await complete;
        } finally {
          database.close();
        }
      }
      for (const [target, entries] of [
        [localStorage, saved.local],
        [sessionStorage, saved.session],
      ] as const) {
        target.clear();
        for (const [key, value] of entries) {
          target.setItem(key, value);
        }
      }
      history.replaceState(null, "", deepLink);
    },
    { storage, url },
  );
}
