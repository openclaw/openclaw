import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThread, CodexThreadListResponse } from "./app-server/protocol.js";
import type { CodexCatalogPageDiagnostics } from "./session-catalog-diagnostics.js";
import { codexCatalogRowRecency } from "./session-catalog-index-order.js";
import type {
  CodexCatalogIndexRow,
  CodexCatalogRolloutFingerprint,
} from "./session-catalog-index-row.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import {
  readControlCursor,
  selectCodexCatalogPreviewInput,
  toCatalogSession,
  truncateCodexCatalogPreview,
} from "./session-catalog-parsing.js";
import { isOpenClawManagedCodexThread } from "./session-catalog-provenance.js";
import { codexCatalogRolloutLogicalPath } from "./session-catalog-rollouts.js";
import {
  copyCodexCatalogSource,
  getCodexCatalogSource,
  setCodexCatalogSource,
  type CodexCatalogSource,
} from "./session-catalog-source.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

type CodexCatalogProjectionParams = {
  localSessionsRoot?: string;
  diagnostics?: CodexCatalogPageDiagnostics | null;
  sanitize: typeof sanitizeTerminalText;
  source?: CodexCatalogSource;
};

/** Single-thread responses remain owned by their native consumers. */
export function projectCodexCatalogThread(thread: CodexThread, localSessionsRoot?: string) {
  try {
    const prepared = projectCodexCatalogNativeThread(thread, sanitizeTerminalText);
    return projectCodexCatalogPage(
      { data: [prepared] },
      {
        localSessionsRoot,
        sanitize: sanitizeTerminalText,
        source: getCodexCatalogSource(prepared),
      },
    );
  } catch (error) {
    return Promise.reject(toErrorObject(error, "Codex catalog projection failed"));
  }
}

export class CodexCatalogProjectionCapacityError extends Error {
  constructor() {
    super("Codex catalog projection queue reached its resident row limit");
  }
}

/** Direct mutations and events share one bound across asynchronous projection work. */
export class CodexCatalogProjections {
  private active = 0;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= CODEX_CATALOG_MAX_ROWS) {
      return Promise.reject(new CodexCatalogProjectionCapacityError());
    }
    this.active++;
    try {
      return work().finally(() => {
        this.active--;
      });
    } catch (error) {
      this.active--;
      return Promise.reject(toErrorObject(error, "Codex catalog projection failed"));
    }
  }
}

export async function projectCodexCatalogPage(
  response: CodexThreadListResponse,
  params: CodexCatalogProjectionParams,
) {
  const { diagnostics, sanitize } = params;
  const responseStarted = performance.now();
  const rows: CodexCatalogIndexRow[] = [];
  const excludedThreadIds: string[] = [];
  try {
    readControlCursor(response.backwardsCursor, "backwards response");
    // Also bound direct/pinned adapters before the first asynchronous provenance read.
    for (const thread of response.data) {
      if (typeof thread.preview === "string" && thread.preview) {
        thread.preview = truncateCodexCatalogPreview(
          selectCodexCatalogPreviewInput(thread.preview),
          sanitize,
        );
      }
    }
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
        const rolloutPath = typeof thread.path === "string" ? thread.path.trim() : "";
        page.managedThreads = [{ threadId: thread.id, ...(rolloutPath ? { rolloutPath } : {}) }];
      } else {
        const session = toCatalogSession(thread, false, sanitize, {
          value: typeof thread.preview === "string" ? thread.preview : undefined,
        });
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
            ...(typeof thread.preview === "string" ? { preview: thread.preview } : {}),
            ...(thread.path ? { rolloutPath: thread.path } : {}),
            updatedAt: asFiniteNumber(thread.updatedAt) ?? null,
            recencyAt: asFiniteNumber(thread.recencyAt) ?? null,
            page,
          },
          params.source ?? getCodexCatalogSource(thread),
        ),
      );
    }
    return {
      rows,
      ...(excludedThreadIds.length ? { excludedThreadIds } : {}),
      nextCursor: readControlCursor(response.nextCursor, "next response"),
      backwardsCursor: readControlCursor(response.backwardsCursor, "backwards response"),
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
    row.updatedAt === (asFiniteNumber(thread.updatedAt) ?? null) &&
    row.recencyAt === (asFiniteNumber(thread.recencyAt) ?? null) &&
    (row.rolloutPath ? codexCatalogRolloutLogicalPath(row.rolloutPath) : undefined) ===
      (thread.path ? codexCatalogRolloutLogicalPath(thread.path) : undefined),
  );
}

export async function projectCodexCatalogDeltaPage(
  response: CodexThreadListResponse,
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
    if (typeof thread.preview === "string" && Boolean(thread.preview) !== Boolean(row.preview)) {
      return undefined;
    }
    const session = toCatalogSession(thread, false, params.sanitize, { value: row.preview });
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
