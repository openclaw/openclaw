import type { CodexThread, CodexThreadListResponse } from "./app-server/protocol.js";
import type { CodexCatalogPageDiagnostics } from "./session-catalog-diagnostics.js";
import { codexCatalogRowRecency } from "./session-catalog-index-order.js";
import type {
  CodexCatalogIndexRow,
  CodexCatalogRolloutFingerprint,
} from "./session-catalog-index-row.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { readControlCursor, toCatalogSession } from "./session-catalog-parsing.js";
import { isOpenClawManagedCodexThread } from "./session-catalog-provenance.js";
import { codexCatalogRolloutLogicalPath } from "./session-catalog-rollouts.js";
import {
  copyCodexCatalogSource,
  getCodexCatalogSource,
  setCodexCatalogSource,
} from "./session-catalog-source.js";
import type { CodexCatalogNativeThread, CodexSessionCatalogPage } from "./session-catalog-types.js";

type CodexCatalogProjectionParams = {
  localSessionsRoot?: string;
  diagnostics?: CodexCatalogPageDiagnostics | null;
};

export class CodexCatalogProjectionCapacityError extends Error {
  constructor() {
    super("Codex catalog projection queue reached its resident row limit");
  }
}

/** Direct mutations and events share one bound across asynchronous projection work. */
export class CodexCatalogProjections {
  private active = 0;

  hasActiveWork(): boolean {
    return this.active > 0;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= CODEX_CATALOG_MAX_ROWS) {
      throw new CodexCatalogProjectionCapacityError();
    }
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
}

/** Consumes metadata already bounded by the native transport or rollout projector. */
export async function projectCodexCatalogPage(
  response: Omit<CodexThreadListResponse, "data"> & { data: CodexCatalogNativeThread[] },
  params: CodexCatalogProjectionParams = {},
) {
  const { diagnostics } = params;
  const responseStarted = performance.now();
  const rows: CodexCatalogIndexRow[] = [];
  const excludedThreadIds: string[] = [];
  try {
    const backwardsCursor = readControlCursor(response.backwardsCursor, "backwards response");
    for (const thread of response.data) {
      if (thread.ephemeral === true) {
        excludedThreadIds.push(thread.id);
        continue;
      }
      const page: CodexSessionCatalogPage = { sessions: [] };
      if (
        await isOpenClawManagedCodexThread(
          thread,
          params.localSessionsRoot,
          diagnostics ?? undefined,
        )
      ) {
        const rolloutPath = thread.path?.trim();
        page.managedThreads = [{ threadId: thread.id, ...(rolloutPath ? { rolloutPath } : {}) }];
      } else {
        const session = toCatalogSession(thread, thread.preview);
        if (session) {
          page.sessions.push(session);
        }
      }
      rows.push(
        setCodexCatalogSource(
          {
            threadId: thread.id,
            archived: false,
            nativeMetadata: true,
            ...(thread.preview != null ? { preview: thread.preview } : {}),
            ...(thread.path ? { rolloutPath: thread.path } : {}),
            updatedAt: thread.updatedAt ?? null,
            recencyAt: thread.recencyAt ?? null,
            page,
          },
          getCodexCatalogSource(thread),
        ),
      );
    }
    return {
      rows,
      ...(excludedThreadIds.length ? { excludedThreadIds } : {}),
      nextCursor: readControlCursor(response.nextCursor, "next response"),
      backwardsCursor,
    };
  } finally {
    if (diagnostics) {
      diagnostics.fields.postResponseMs =
        (diagnostics.fields.postResponseMs ?? 0) + performance.now() - responseStarted;
    }
  }
}

/** Native activity/path changes invalidate the retained first-user preview. */
export function canReuseCodexCatalogPreview(
  row: CodexCatalogIndexRow | undefined,
  thread: Pick<CodexThread, "id" | "path" | "updatedAt" | "recencyAt">,
): boolean {
  return Boolean(
    row &&
    !row.archived &&
    row.updatedAt === (thread.updatedAt ?? null) &&
    row.recencyAt === (thread.recencyAt ?? null) &&
    (row.rolloutPath ? codexCatalogRolloutLogicalPath(row.rolloutPath) : undefined) ===
      (thread.path ? codexCatalogRolloutLogicalPath(thread.path) : undefined),
  );
}

export async function projectCodexCatalogDeltaPage(
  response: Omit<CodexThreadListResponse, "data"> & { data: CodexCatalogNativeThread[] },
  params: CodexCatalogProjectionParams & {
    getRow: (threadId: string) => CodexCatalogIndexRow | undefined;
  },
) {
  const reusable = response.data.map((thread) => {
    const row = params.getRow(thread.id);
    if (thread.ephemeral === true || !row || !canReuseCodexCatalogPreview(row, thread)) {
      return undefined;
    }
    if (row.page.sessions.length === 0) {
      return copyCodexCatalogSource(thread, { ...row, nativeMetadata: true });
    }
    if (thread.preview != null && Boolean(thread.preview) !== Boolean(row.preview)) {
      return undefined;
    }
    const session = toCatalogSession(thread, row.preview);
    return copyCodexCatalogSource(thread, {
      ...row,
      nativeMetadata: true,
      page: { sessions: session ? [session] : [] },
    });
  });
  const changed = await projectCodexCatalogPage(
    { ...response, data: response.data.filter((_thread, index) => !reusable[index]) },
    params,
  );
  let changedIndex = 0;
  return {
    ...changed,
    rows: reusable.flatMap((row, index) =>
      response.data[index]?.ephemeral === true ? [] : [row ?? changed.rows[changedIndex++]!],
    ),
  };
}

/** Sampled rollout content cannot supersede authoritative native settings. */
export function mergeCodexCatalogRolloutRow(
  row: CodexCatalogIndexRow,
  existing: CodexCatalogIndexRow | undefined,
  fingerprint: CodexCatalogRolloutFingerprint,
): CodexCatalogIndexRow {
  const recencyAt =
    row.recencyAt === null
      ? (existing?.recencyAt ?? null)
      : Math.max(row.recencyAt, existing?.recencyAt ?? row.recencyAt);
  const metadata = existing?.nativeMetadata ? existing : row;
  const preview = row.preview ?? metadata.preview;
  const sessions = metadata.page.sessions.map((session) => {
    const updated = Object.assign({}, session);
    delete updated.fallbackName;
    if (!session.name && preview) {
      updated.fallbackName = preview;
    }
    if (recencyAt !== null) {
      updated.recencyAt = recencyAt;
    }
    return updated;
  });
  const merged: CodexCatalogIndexRow = {
    ...metadata,
    nativeMetadata: existing?.nativeMetadata ?? false,
    archived: existing?.archived ?? false,
    recencyAt,
    fingerprint,
    ...(preview !== undefined ? { preview } : {}),
    page: { ...metadata.page, sessions },
  };
  if (existing && codexCatalogRowRecency(merged) > codexCatalogRowRecency(existing)) {
    delete merged.sourceOrder;
  }
  return merged;
}
