import fs from "node:fs/promises";
import path from "node:path";
import { constants, createZstdDecompress } from "node:zlib";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { root as openSafeRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexSessionSource, CodexThread } from "./app-server/protocol.js";
import type {
  CodexCatalogIndexRow,
  CodexCatalogRolloutFingerprint,
} from "./session-catalog-index-row.js";
import { detachCodexCatalogString } from "./session-catalog-limits.js";
import { boundedCatalogString, truncateCodexCatalogPreview } from "./session-catalog-parsing.js";

const WINDOW_BYTES = 128 * 1024;
const ROLLOUT_SOURCE_DENIAL_CODES = new Set([
  "symlink",
  "hardlink",
  "outside-workspace",
  "invalid-path",
  "device-path",
  "not-file",
  "path-alias",
]);

/** Codex returns the plain logical path for either rollout representation. */
export function codexCatalogRolloutLogicalPath(rolloutPath: string): string {
  return rolloutPath.replace(/\.zst$/u, "");
}

export function resolveCodexCatalogRolloutFingerprint(
  rolloutPath: string | undefined,
  previous: Pick<CodexCatalogIndexRow, "rolloutPath" | "fingerprint"> | undefined,
  files?: ReadonlyMap<string, CodexCatalogRolloutFingerprint>,
): CodexCatalogRolloutFingerprint | undefined {
  const logicalPath = rolloutPath && codexCatalogRolloutLogicalPath(rolloutPath);
  if (!logicalPath) {
    return undefined;
  }
  return (
    files?.get(logicalPath) ??
    files?.get(`${logicalPath}.zst`) ??
    (previous?.rolloutPath && codexCatalogRolloutLogicalPath(previous.rolloutPath) === logicalPath
      ? previous.fingerprint
      : undefined)
  );
}

function* records(bytes: Buffer, skipFirst: boolean) {
  const text = bytes.toString("utf8");
  let start = skipFirst ? text.indexOf("\n") + 1 : 0;
  for (let end; (end = text.indexOf("\n", start)) !== -1; start = end + 1) {
    const line = text.slice(start, end);
    // Keep the physical first line for envelope validation. Unicode escapes can
    // encode any event tag; other lines need a catalog event before parsing.
    if (
      start > 0 &&
      !/"(?:user_message|item_completed|task_started|turn_started|thread_settings_applied)"|\\u/u.test(
        line,
      )
    ) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      yield isRecord(value) ? value : undefined;
    } catch {
      yield undefined;
    }
  }
}

function sourceFromMetadata(value: unknown): CodexSessionSource {
  if (value === undefined) {
    return "vscode";
  }
  if (value === "cli" || value === "vscode" || value === "exec") {
    return value;
  }
  if (value === "mcp") {
    return "appServer";
  }
  if (isRecord(value)) {
    const custom = boundedCatalogString(value.custom, 500);
    if (custom) {
      return { custom };
    }
  }
  return "unknown";
}

function previewFromEvent(
  payload: Record<string, unknown>,
  sanitize: typeof sanitizeTerminalText,
): string | undefined {
  let message: string | undefined;
  let image = false;
  let audio = false;
  if (payload.type === "user_message") {
    message = typeof payload.message === "string" ? payload.message : undefined;
    image = [payload.images, payload.local_images].some(
      (items) => Array.isArray(items) && items.length > 0,
    );
    audio = [payload.audio, payload.local_audio].some(
      (items) => Array.isArray(items) && items.length > 0,
    );
  } else if (
    payload.type === "item_completed" &&
    isRecord(payload.item) &&
    payload.item.type === "UserMessage" &&
    Array.isArray(payload.item.content)
  ) {
    const content = payload.item.content.filter(isRecord);
    message = content
      .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
      .join("");
    image = content.some((item) => item.type === "image" || item.type === "local_image");
    audio = content.some((item) => item.type === "audio" || item.type === "local_audio");
  }
  const prefix = "## My request for Codex:";
  if (message?.includes(prefix)) {
    message = message.slice(message.indexOf(prefix) + prefix.length);
  }
  return (
    truncateCodexCatalogPreview(message ?? "", sanitize) ||
    (image ? "[Image]" : audio ? "[Audio]" : undefined)
  );
}

async function compressedHead(handle: fs.FileHandle, size: number): Promise<Buffer> {
  const input = Buffer.alloc(Math.min(size, WINDOW_BYTES));
  const { bytesRead } = await handle.read(input, 0, input.length, 0);
  const decoder = createZstdDecompress({
    chunkSize: 16 * 1024,
    params: { [constants.ZSTD_d_windowLogMax]: 25 },
  });
  decoder.end(input.subarray(0, bytesRead));
  const timer = setTimeout(() => decoder.destroy(new Error("Rollout read timed out")), 5_000);
  const chunks: Buffer[] = [];
  let sizeRead = 0;
  try {
    for await (const chunk of decoder) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = bytes.subarray(0, WINDOW_BYTES - sizeRead);
      chunks.push(bounded);
      sizeRead += bounded.length;
      if (sizeRead === WINDOW_BYTES) {
        break;
      }
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    decoder.destroy();
  }
}

/** Background-only display projection; never reads an entire large rollout. */
export async function readCodexCatalogRollout(
  sessionsRoot: string,
  rolloutPath: string,
): Promise<CodexThread | undefined> {
  let opened: Awaited<ReturnType<Awaited<ReturnType<typeof openSafeRoot>>["open"]>> | undefined;
  try {
    const rootStat = await fs.lstat(sessionsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return undefined;
    }
    const safeRoot = await openSafeRoot(sessionsRoot, {
      hardlinks: "reject",
      symlinks: "reject",
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    opened = await safeRoot.open(path.relative(sessionsRoot, rolloutPath));
    const { handle, stat } = opened;
    if (!stat.size) {
      return undefined;
    }
    const compressed = rolloutPath.endsWith(".zst");
    const head = compressed
      ? await compressedHead(handle, stat.size)
      : Buffer.alloc(Math.min(stat.size, WINDOW_BYTES));
    if (!compressed) {
      await handle.read(head, 0, head.length, 0);
    }
    const first = records(head, false);
    const envelope = first.next().value;
    if (envelope?.type !== "session_meta" || !isRecord(envelope.payload)) {
      return undefined;
    }
    const metadata = envelope.payload;
    const id = boundedCatalogString(metadata.id, 256);
    const createdAt =
      typeof metadata.timestamp === "string" ? Date.parse(metadata.timestamp) : Number.NaN;
    if (!id || !Number.isFinite(createdAt)) {
      return undefined;
    }
    const windows = [first];
    if (!compressed && stat.size > head.length) {
      const offset = Math.max(head.length, stat.size - WINDOW_BYTES);
      const bytes = Buffer.alloc(stat.size - offset);
      await handle.read(bytes, 0, bytes.length, offset);
      windows.push(records(bytes, true));
    }
    const thread: CodexThread = {
      id,
      projectId: null,
      path: detachCodexCatalogString(rolloutPath),
      source: sourceFromMetadata(metadata.source),
      createdAt: createdAt / 1_000,
      updatedAt: stat.mtimeMs / 1_000,
      cwd: boundedCatalogString(metadata.cwd, 4096),
      originator:
        typeof metadata.originator === "string" && metadata.originator.length <= 500
          ? detachCodexCatalogString(metadata.originator)
          : undefined,
      sessionId: boundedCatalogString(metadata.session_id, 256),
    };
    // Response items include injected model context. Only native user events
    // represent a first-user preview; a missed prefix keeps the native value.
    const { sanitizeTerminalText } = await import("openclaw/plugin-sdk/text-chunking");
    for (const window of windows) {
      for (const record of window) {
        if (record?.type !== "event_msg" || !isRecord(record.payload)) {
          continue;
        }
        const payload = record.payload;
        if (window === first && !thread.preview) {
          const preview = previewFromEvent(payload, sanitizeTerminalText);
          if (preview) {
            thread.preview = preview;
          }
        }
        if (payload.type === "task_started" || payload.type === "turn_started") {
          const startedAt =
            typeof payload.started_at === "number"
              ? payload.started_at
              : typeof record.timestamp === "string"
                ? Date.parse(record.timestamp) / 1_000
                : Number.NaN;
          // Codex advances recency for turn starts, not file rewrites. Match the
          // protocol's whole seconds so a reread preserves native tie ordering.
          if (Number.isFinite(startedAt)) {
            thread.recencyAt = Math.max(
              thread.recencyAt ?? Number.NEGATIVE_INFINITY,
              Math.floor(startedAt),
            );
          }
        }
        if (payload.type === "thread_settings_applied" && isRecord(payload.thread_settings)) {
          thread.cwd = boundedCatalogString(payload.thread_settings.cwd, 4096) ?? thread.cwd;
        }
      }
    }
    return thread;
  } catch (error) {
    const code = extractErrorCode(error);
    if (code && ROLLOUT_SOURCE_DENIAL_CODES.has(code)) {
      return undefined;
    }
    // Failed observations must not become cached absences: permissions and
    // raced identities can recover without changing a rollout's mtime or size.
    throw error;
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}
