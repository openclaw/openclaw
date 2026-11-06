import type { Page } from "playwright";
import type { ChatDetailsSnapshot } from "../../ui/src/pages/chat/session-details-snapshot-schema.ts";
// Only these structural ports cross Playwright's serialized browser boundary.
type ChatSessionSnapshot = {
  messages: unknown[];
  details?: Pick<ChatDetailsSnapshot, "subagents">;
  rowDisplay?: Record<
    string,
    {
      links?: Record<string, unknown>;
      images?: Record<string, { width: number; height: number; thumbnail?: Blob }>;
    }
  >;
};
type SessionSnapshotStore = {
  write(key: string, snapshot: ChatSessionSnapshot, weight: number): void;
  flush(): Promise<void>;
};

type SidebarSnapshotModel = {
  navigationView: string;
  onlineUsers: unknown[];
  scrollTop?: number;
  roster?: { result: { sessions: Array<{ key: string }> } } | null;
};

type StoredTranscript = {
  sessionKey: string;
  projectionVersion: number;
  snapshot: ChatSessionSnapshot;
};
type StoredSidebar = {
  sessionKey: string;
  projectionVersion: number;
  model: SidebarSnapshotModel;
};
type WarmThumbnail = {
  sessionKey: string;
  messageId: string;
  imageKey: string;
  mime: string;
  base64: string;
};

/** Read the real display receipt before either benchmark freezes its warm input. */
export function qualifyDetailsSubagentsWarmState(input: {
  sessionKey: string;
  rows: Array<{ key: string; label: string }>;
}) {
  const pane = document.querySelector(".chat-pane-cache__pane--active");
  const store: SessionSnapshotStore | undefined = pane
    ? Reflect.get(pane, "sessionSnapshotStore")
    : undefined;
  const cache: Map<string, { snapshot: ChatSessionSnapshot }> | undefined = pane
    ? Reflect.get(pane, "chatMessagesBySession")
    : undefined;
  const entry = cache && [...cache].find(([key]) => key.endsWith(`\u0000${input.sessionKey}`));
  const matches = (receipt: ChatDetailsSnapshot["subagents"]) => {
    const ordinary = receipt?.rows.filter((row) => row.listed === false) ?? [];
    return (
      input.rows.length > 0 &&
      ordinary.length === input.rows.length &&
      receipt?.counts
        .filter((count) => count.listed === false)
        .reduce((total, count) => total + count.count, 0) === input.rows.length &&
      input.rows.every((row) =>
        ordinary.some((saved) => saved.key === row.key && saved.label === row.label),
      )
    );
  };
  const group = pane?.querySelector<HTMLElement>('[data-details-group="subagents"]');
  const labels = [...(group?.querySelectorAll(".chat-subagent-activity__name") ?? [])].map((row) =>
    row.textContent?.trim(),
  );
  if (
    !store ||
    !entry ||
    !matches(entry[1].snapshot.details?.subagents) ||
    !group ||
    document.fonts.status !== "loaded" ||
    labels.length !== input.rows.length ||
    !input.rows.every((row) => labels.includes(row.label)) ||
    group
      .getAnimations({ subtree: true })
      .some(
        (animation) =>
          (animation.pending || animation.playState === "running") &&
          animation.effect?.getTiming().iterations !== Infinity,
      )
  ) {
    return null;
  }
  const height = group.getBoundingClientRect().height;
  if (height <= 0) {
    return null;
  }
  // Playwright treats a returned Promise as ready; poll synchronous readiness first.
  return (async () => {
    await store.flush();
    if (!(await indexedDB.databases()).some(({ name }) => name === "openclaw-chat-snapshots")) {
      throw new Error("Qualified ordinary child snapshot was not persisted");
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openclaw-chat-snapshots");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const record = await new Promise<StoredTranscript | undefined>((resolve, reject) => {
        const request = database.transaction("snapshots").objectStore("snapshots").get(entry[0]);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const receipt = record?.snapshot.details?.subagents;
      const settledHeight = group.getBoundingClientRect().height;
      if (!record || !receipt || !matches(receipt) || Math.abs(settledHeight - height) > 1) {
        throw new Error("Persisted ordinary child receipt or settled geometry changed");
      }
      return {
        sessionKey: input.sessionKey,
        snapshotKey: record.sessionKey,
        projectionVersion: record.projectionVersion,
        ordinaryRows: receipt.rows.filter((row) => row.listed === false),
        labels,
        settledHeightPx: settledHeight,
      };
    } finally {
      database.close();
    }
  })();
}

export async function persistColdLoadWarmState(input: {
  sessionKey: string;
  sidebarView: "sessions" | "online";
  offRosterSession?: boolean;
  rowFacts?: boolean;
  lateRowFacts?: boolean;
  detailsSubagentsWarmState?: Awaited<ReturnType<typeof qualifyDetailsSubagentsWarmState>>;
}) {
  const pane = document.querySelector(".chat-pane-cache__pane--active");
  const store: SessionSnapshotStore | undefined = pane
    ? Reflect.get(pane, "sessionSnapshotStore")
    : undefined;
  const cache: Map<string, { snapshot: ChatSessionSnapshot; weight: number }> | undefined = pane
    ? Reflect.get(pane, "chatMessagesBySession")
    : undefined;
  const entry = cache && [...cache].find(([key]) => key.endsWith(`\u0000${input.sessionKey}`));
  if (!store || !entry) {
    throw new Error("Warm reload requires the active transcript cache owner");
  }
  store.write(entry[0], { ...entry[1].snapshot }, entry[1].weight);
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
    const snapshotBytes = new TextEncoder().encode(
      JSON.stringify(record, (_key, value) => (value instanceof Blob ? undefined : value)),
    ).byteLength;
    const thumbnailWeight = { count: 0, bytes: 0, selectedCount: 0, selectedBytes: 0 };
    const thumbnails: WarmThumbnail[] = [];
    for (const saved of snapshots) {
      for (const [messageId, facts] of Object.entries(saved.snapshot.rowDisplay ?? {})) {
        for (const [imageKey, image] of Object.entries(facts.images ?? {})) {
          const blob = image.thumbnail;
          if (!(blob instanceof Blob)) {
            continue;
          }
          thumbnailWeight.count++;
          thumbnailWeight.bytes += blob.size;
          if (saved === record) {
            thumbnailWeight.selectedCount++;
            thumbnailWeight.selectedBytes += blob.size;
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          }
          thumbnails.push({
            sessionKey: saved.sessionKey,
            messageId,
            imageKey,
            mime: blob.type,
            base64: btoa(binary),
          });
          // Playwright's value boundary does not carry native Blob contents.
          delete image.thumbnail;
        }
      }
    }
    const displayFacts = Object.values(record.snapshot.rowDisplay ?? {});
    return {
      detailsSubagentsWarmState: input.detailsSubagentsWarmState,
      rosterContainsSession,
      storage: {
        records: { snapshots, sidebarSnapshots: sidebars, snapshotMetadata: metadata },
        thumbnails,
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      },
      messages: record.snapshot.messages.length,
      snapshotBytes,
      ...(input.lateRowFacts
        ? {
            displayFacts: {
              rows: displayFacts.length,
              links: displayFacts.reduce(
                (count, facts) => count + Object.keys(facts.links ?? {}).length,
                0,
              ),
              imageDimensions: displayFacts.reduce(
                (count, facts) => count + Object.keys(facts.images ?? {}).length,
                0,
              ),
              thumbnails: thumbnailWeight.selectedCount,
              thumbnailBytes: thumbnailWeight.selectedBytes,
              cachedThumbnails: thumbnailWeight.count,
              cachedThumbnailBytes: thumbnailWeight.bytes,
            },
          }
        : {}),
      databaseVersion: database.version,
      projectionVersion: record.projectionVersion,
      sidebarView: sidebar.model.navigationView,
      sidebarScrollTop: document.querySelector(".sidebar-shell__body")?.scrollTop ?? 0,
      sidebarCachedScrollTop: sidebar.model.scrollTop,
      sidebarPeople: sidebar.model.onlineUsers.length,
      sidebarProjectionVersion: sidebar.projectionVersion,
      sidebarBytes: new TextEncoder().encode(JSON.stringify(sidebar.model)).byteLength,
      sidebarRecordBytes: new TextEncoder().encode(JSON.stringify(sidebar)).byteLength,
      sidebarAggregateBytes: sidebars.reduce(
        (bytes, saved) => bytes + new TextEncoder().encode(JSON.stringify(saved)).byteLength,
        0,
      ),
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
      const savedRecords: typeof storage.records = JSON.parse(saved.records);
      for (const thumbnail of saved.thumbnails) {
        const record = savedRecords.snapshots.find(
          (row) => row.sessionKey === thumbnail.sessionKey,
        );
        const image =
          record?.snapshot.rowDisplay?.[thumbnail.messageId]?.images?.[thumbnail.imageKey];
        if (!image) {
          throw new Error("Warm thumbnail lost its owning snapshot row");
        }
        const bytes = Uint8Array.from(atob(thumbnail.base64), (character) =>
          character.charCodeAt(0),
        );
        image.thumbnail = new Blob([bytes], { type: thumbnail.mime });
      }
      const databases: Record<string, Record<string, unknown[]>> = {
        "openclaw-chat-snapshots": savedRecords,
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
    { storage: { ...storage, records: JSON.stringify(storage.records) }, url },
  );
}
