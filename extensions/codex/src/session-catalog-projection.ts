import type { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import type { CodexCatalogPageDiagnostics } from "./session-catalog-diagnostics.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index.js";
import {
  readControlCursor,
  toCatalogSession,
  truncateCodexCatalogPreview,
} from "./session-catalog-parsing.js";
import { isOpenClawManagedCodexThread } from "./session-catalog-provenance.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

export async function projectCodexCatalogPage(
  response: CodexThreadListResponse,
  params: {
    localSessionsRoot?: string;
    diagnostics?: CodexCatalogPageDiagnostics | null;
    sanitize: typeof sanitizeTerminalText;
  },
) {
  const { diagnostics, sanitize } = params;
  const responseStarted = performance.now();
  const rows: CodexCatalogIndexRow[] = [];
  try {
    readControlCursor(response.backwardsCursor, "backwards response");
    // Also bound direct/pinned adapters before the first asynchronous provenance read.
    for (const thread of response.data) {
      if (typeof thread.preview === "string") {
        thread.preview = truncateCodexCatalogPreview(thread.preview, sanitize);
      }
    }
    for (const thread of response.data) {
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
        const session = toCatalogSession(thread, false, sanitize);
        if (session) {
          page.sessions.push(session);
        }
      }
      rows.push({
        threadId: thread.id,
        updatedAt:
          typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
            ? thread.updatedAt
            : null,
        recencyAt:
          typeof thread.recencyAt === "number" && Number.isFinite(thread.recencyAt)
            ? thread.recencyAt
            : null,
        page,
      });
    }
    return {
      rows,
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
