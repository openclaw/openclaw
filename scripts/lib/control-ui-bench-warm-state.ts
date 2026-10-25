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
  avatarImages?: Array<{ blob?: Blob | null }>;
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
    let blobBytes = 0;
    const sidebarJson = JSON.stringify(sidebar.model, (_key, value: unknown) => {
      if (!(value instanceof Blob)) return value;
      blobBytes += value.size;
      return null;
    });
    // Playwright's JSON boundary cannot carry IDB's native Blob values.
    const sidebarBlobs: Array<{
      sessionKey: string;
      index: number;
      type: string;
      bytes: number[];
    }> = [];
    for (const record of sidebars) {
      for (const [index, image] of (record.model.avatarImages ?? []).entries()) {
        if (image.blob instanceof Blob) {
          sidebarBlobs.push({
            sessionKey: record.sessionKey,
            index,
            type: image.blob.type,
            bytes: Array.from(new Uint8Array(await image.blob.arrayBuffer())),
          });
          image.blob = null;
        }
      }
    }
    return {
      rosterContainsSession,
      storage: {
        sidebarBlobs,
        records: { snapshots, sidebarSnapshots: sidebars, snapshotMetadata: metadata },
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      },
      messages: record.snapshot.messages.length,
      databaseVersion: database.version,
      projectionVersion: record.projectionVersion,
      sidebarView: sidebar.model.navigationView,
      sidebarPeople: sidebar.model.onlineUsers.length,
      sidebarBytes: new TextEncoder().encode(sidebarJson).byteLength + blobBytes,
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
  await page.evaluate(
    async ({ storage: saved, url: deepLink }) => {
      for (const image of saved.sidebarBlobs) {
        const record = saved.records.sidebarSnapshots.find(
          (record) => record.sessionKey === image.sessionKey,
        );
        const target = record?.model.avatarImages?.[image.index];
        if (!target) throw new Error("Warm sidebar image lost its snapshot owner");
        target.blob = new Blob([new Uint8Array(image.bytes)], { type: image.type });
      }
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
