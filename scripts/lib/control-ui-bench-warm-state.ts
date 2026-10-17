import type { Page } from "playwright";

// The serialized browser probe needs only these ports, not the UI module graph.
type ChatSnapshot = { messages: unknown[] };
type SnapshotStore = {
  write(sessionKey: string, snapshot: ChatSnapshot): void;
  flush(): Promise<void>;
};

type StoredTranscript = {
  sessionKey: string;
  projectionVersion: number;
  snapshot: ChatSnapshot;
};
type StoredSidebar = {
  sessionKey: string;
  model: {
    navigationView: "sessions" | "online";
    sessions: unknown[];
    onlineUsers: unknown[];
  };
};

/** Runs in the page before measurement; the application owns both cache projections. */
export async function persistColdLoadWarmState(input: {
  sessionKey: string;
  sidebarView: "sessions" | "online";
}) {
  const pane = document.querySelector(".chat-pane-cache__pane--active");
  const store: SnapshotStore | undefined = pane
    ? Reflect.get(pane, "sessionSnapshotStore")
    : undefined;
  const cache: Map<string, { snapshot: ChatSnapshot }> | undefined = pane
    ? Reflect.get(pane, "chatMessagesBySession")
    : undefined;
  const entry =
    cache && [...cache.entries()].find(([key]) => key.endsWith(`\u0000${input.sessionKey}`));
  if (!store || !entry) {
    throw new Error("Warm reload requires the active transcript cache owner");
  }
  store.write(entry[0], { ...entry[1].snapshot });
  const started = performance.now();
  const flushed = store.flush();
  const serializeMs = performance.now() - started;
  await flushed;
  const writeMs = performance.now() - started;
  const request = indexedDB.open("openclaw-chat-snapshots");
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Snapshot database open failed")),
      { once: true },
    );
  });
  try {
    const transaction = database.transaction(["snapshots", "sidebarSnapshots", "snapshotMetadata"]);
    const readAll = <T>(name: string) =>
      new Promise<T[]>((resolve, reject) => {
        const read = transaction.objectStore(name).getAll();
        read.addEventListener("success", () => resolve(read.result), { once: true });
        read.addEventListener(
          "error",
          () => reject(read.error ?? new Error("Snapshot read failed")),
          { once: true },
        );
      });
    const [snapshots, sidebars, metadata] = await Promise.all([
      readAll<StoredTranscript>("snapshots"),
      readAll<StoredSidebar>("sidebarSnapshots"),
      readAll<unknown>("snapshotMetadata"),
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
        snapshots,
        sidebarSnapshots: sidebars,
        snapshotMetadata: metadata,
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
      },
      measurement: "initial warm visit persistence; replayed before each measured reload",
      serializeMs,
      writeMs,
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
  // Unload first: live/pagehide writers must finish before replaying the application's records.
  await page.mainFrame().goto(resetUrl);
  await page.unroute(resetUrl);
  await page.evaluate("globalThis.__name = (fn) => fn");
  await page.evaluate(
    async ({ storage, url }) => {
      localStorage.clear();
      sessionStorage.clear();
      for (const [key, value] of storage.localStorage) localStorage.setItem(key, value);
      for (const [key, value] of storage.sessionStorage) sessionStorage.setItem(key, value);
      const request = indexedDB.open("openclaw-chat-snapshots");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener(
          "error",
          () => reject(request.error ?? new Error("Warm-state database open failed")),
          { once: true },
        );
      });
      try {
        const names = ["snapshots", "sidebarSnapshots", "snapshotMetadata"] as const;
        const transaction = database.transaction([...names], "readwrite");
        const complete = new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve(), { once: true });
          transaction.addEventListener(
            "abort",
            () => reject(transaction.error ?? new Error("Warm-state replay aborted")),
            { once: true },
          );
        });
        for (const name of names) {
          const store = transaction.objectStore(name);
          store.clear();
          for (const record of storage[name]) store.put(record);
        }
        await complete;
      } finally {
        database.close();
      }
      history.replaceState(null, "", url);
    },
    { storage, url },
  );
}
