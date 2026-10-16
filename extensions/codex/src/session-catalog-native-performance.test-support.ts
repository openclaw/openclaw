import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CodexAppServerClient } from "./app-server/client.js";
import { createCodexNativeTestState } from "./app-server/native-app-server.test-support.js";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import type { CodexCatalogPreviewCache } from "./session-catalog-native-projection.js";

export type NativeCatalogBoundary = "ordinary" | "catalog";
const PAGE_SIZE = 64;
const CREATED_AT = "2025-01-01T00:00:00.000Z";
const rolloutRecord = (type: string, payload: unknown) =>
  JSON.stringify({ timestamp: CREATED_AT, type, payload });

export async function createNativeCatalogPerformanceFixture(
  root: string,
  options: { count: number; previewBytes: number; assistantBytes?: number },
) {
  const state = await createCodexNativeTestState(root);
  const directory = path.join(state.codexHome, "sessions", "2025", "01", "01");
  await fs.mkdir(directory, { recursive: true });
  const paragraph =
    "Review the retry queue and preserve the original request deadline. Check cancellation, delayed replies, and the caller that joins while work is pending. Explain the observed failure and verify the resulting behavior.\n";
  for (let offset = 0; offset < options.count; offset += 16) {
    await Promise.all(
      Array.from({ length: Math.min(16, options.count - offset) }, async (_, index) => {
        const position = offset + index;
        const id = `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`;
        const firstLine = `Investigate the session sidebar for project ${position}.\n`;
        const message = (
          firstLine + paragraph.repeat(Math.ceil(options.previewBytes / paragraph.length))
        ).slice(0, options.previewBytes);
        const contents = [
          rolloutRecord("session_meta", {
            id,
            timestamp: CREATED_AT,
            cwd: state.cwd,
            originator: "codex_cli_rs",
            source: "cli",
            cli_version: CODEX_APP_SERVER_VERSION,
            model_provider: "openai",
          }),
          rolloutRecord("event_msg", { type: "user_message", message, kind: "plain" }),
          ...(options.assistantBytes
            ? [
                rolloutRecord("event_msg", {
                  type: "agent_message",
                  message: "x".repeat(options.assistantBytes),
                }),
              ]
            : []),
          "",
        ].join("\n");
        await fs.writeFile(
          path.join(directory, `rollout-2025-01-01T00-00-00-${id}.jsonl`),
          contents,
        );
      }),
    );
  }
  return state;
}

export async function startNativeCatalogPerformanceClient(
  state: Awaited<ReturnType<typeof createCodexNativeTestState>>,
) {
  const child = spawn(state.command, ["app-server"], {
    cwd: state.cwd,
    env: state.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = CodexAppServerClient.fromTransportForTests(child);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.closeAndWait();
    throw error;
  }
}

function readPage(
  client: CodexAppServerClient,
  boundary: NativeCatalogBoundary,
  useStateDbOnly: boolean,
  cursor?: string,
  previewCache?: CodexCatalogPreviewCache,
) {
  return client.request<CodexThreadListResponse>(
    "thread/list",
    {
      limit: PAGE_SIZE,
      archived: false,
      modelProviders: [],
      sortKey: "recency_at",
      sortDirection: "desc",
      useStateDbOnly,
      ...(cursor ? { cursor } : {}),
    },
    {
      timeoutMs: 60_000,
      ...(boundary === "catalog"
        ? { catalogPreview: true, ...(previewCache ? { catalogPreviewCache: previewCache } : {}) }
        : {}),
    },
  );
}

/** Return only scalar observations; retaining RPC promises would retain every native page. */
export async function walkNativeCatalog(
  client: CodexAppServerClient,
  boundary: NativeCatalogBoundary,
  options: {
    useStateDbOnly: boolean;
    observePage?: (page: CodexThreadListResponse) => void;
    previewCache?: CodexCatalogPreviewCache;
  },
) {
  let rows = 0;
  let pages = 0;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await readPage(
      client,
      boundary,
      options.useStateDbOnly,
      cursor,
      options.previewCache,
    );
    rows += page.data.length;
    pages++;
    options.observePage?.(page);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) {
      throw new Error("Native performance fixture returned a repeated cursor");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  return { rows, pages };
}

export async function measureNativeCatalogBoundary(
  client: CodexAppServerClient,
  boundary: NativeCatalogBoundary,
  previewCache: CodexCatalogPreviewCache,
) {
  const page = await readPage(client, boundary, true, undefined, previewCache);
  return {
    ...(await walkNativeCatalog(client, boundary, { useStateDbOnly: true, previewCache })),
    retainedPageBytes: Buffer.byteLength(JSON.stringify(page)),
    pageRows: page.data.length,
    maxPreviewCharacters: Math.max(0, ...page.data.map((row) => row.preview?.length ?? 0)),
    firstThreadId: page.data[0]?.id,
  };
}
