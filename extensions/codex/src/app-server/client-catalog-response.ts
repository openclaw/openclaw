import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import {
  projectCodexCatalogNativeResponse,
  projectCodexCatalogNativeThread,
  type CodexCatalogPreviewCache,
} from "../session-catalog-native-projection.js";
import type { CodexCatalogNativeThread } from "../session-catalog-types.js";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";
import { parseCodexAppServerMessage } from "./client-message-decoder.js";
import {
  codexCatalogResponseRoute,
  type CodexCatalogDecodeRoute,
} from "./client-message-frames.js";
import { isJsonObject, isRpcResponse } from "./protocol.js";
import type { CodexRequestAttempt } from "./request-attempt.js";

export type CodexClientRequestAttempt = CodexRequestAttempt & {
  catalogProjection?: { preview?: CodexCatalogPreviewCache; remainingRows?: number };
};

export type CodexCatalogDecodeInput = {
  bytes: Uint8Array<ArrayBuffer>;
  route: CodexCatalogDecodeRoute;
  remainingRows?: number;
};
export type CodexCatalogDecodeResult = {
  message?: unknown;
  preview?: { rows: CodexCatalogNativeThread[]; states: (boolean | undefined)[] };
  projectionError?: { id: number; error: Error };
  failures: { value: string; error: unknown; fragmentCount: number }[];
};

/** Each worker invocation parses and projects one complete transport frame. */
export function decodeCodexCatalogFrame(input: CodexCatalogDecodeInput): CodexCatalogDecodeResult {
  const failures: CodexCatalogDecodeResult["failures"] = [];
  const parsed = parseCodexAppServerMessage(
    Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength).toString(
      "utf8",
    ),
    (value, error, fragmentCount) => {
      // Redact before bounding: cutting a quoted token first loses its closing quote.
      failures.push({ value: redactCodexAppServerLinePreview(value), error, fragmentCount });
    },
  );
  return { ...projectCodexCatalogMessage(parsed, input), failures };
}

export function projectCodexCatalogMessage(
  parsed: unknown,
  input: Omit<CodexCatalogDecodeInput, "bytes">,
  cachedPreview?: CodexCatalogPreviewCache,
): CodexCatalogDecodeResult {
  const result: CodexCatalogDecodeResult = { failures: [] };
  if (!isJsonObject(parsed)) {
    return result;
  }
  result.message = parsed;
  if (!isRpcResponse(parsed)) {
    return result;
  }
  const message = parsed;
  const route = codexCatalogResponseRoute(message.id);
  if (message.error || !route) {
    return result;
  }
  const remainingRows = input.route === "unresolved" ? 0 : input.remainingRows;
  try {
    if (!isJsonObject(message.result)) {
      throw new Error("Codex catalog response contains an invalid result");
    }
    if (route.kind === "list") {
      const raw = message.result;
      const page = projectCodexCatalogNativeResponse(
        raw,
        sanitizeTerminalText,
        cachedPreview,
        remainingRows,
      );
      message.result = page;
      if (!cachedPreview) {
        const states = Array.isArray(raw.data)
          ? raw.data
              .slice(0, page.data.length)
              .map((row) =>
                isJsonObject(row) && typeof row.preview === "string"
                  ? Boolean(row.preview)
                  : undefined,
              )
          : [];
        result.preview = { rows: page.data, states };
      }
    } else {
      const thread = message.result.thread;
      const projected = projectCodexCatalogNativeThread(thread, sanitizeTerminalText);
      // Catalog eligibility also selects the native history pagination protocol.
      message.result = {
        thread: {
          ...projected,
          ...(isJsonObject(thread) && typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
          ...(isJsonObject(thread) &&
          (thread.historyMode === "paginated" || thread.historyMode === "legacy")
            ? { historyMode: thread.historyMode }
            : {}),
        },
      };
    }
  } catch (error) {
    delete result.message;
    result.projectionError = {
      id: route.id,
      error:
        error instanceof Error
          ? error
          : new Error("Codex catalog projection failed", { cause: error }),
    };
  }
  return result;
}
