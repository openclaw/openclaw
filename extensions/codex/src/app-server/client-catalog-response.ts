import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import {
  projectCodexCatalogNativeResponse,
  projectCodexCatalogNativeThread,
  type CodexCatalogPreviewCache,
} from "../session-catalog-native-projection.js";
import { redactCodexAppServerLinePreview } from "./client-line-preview.js";
import { CodexAppServerMessageDecoder } from "./client-message-decoder.js";
import {
  codexCatalogResponseRoute,
  type CodexCatalogDecodeRoute,
} from "./client-message-frames.js";
import { isJsonObject, isRpcResponse } from "./protocol.js";

export type CodexCatalogDecodeInput = {
  bytes: Uint8Array<ArrayBuffer>;
  route: CodexCatalogDecodeRoute;
  remainingRows?: number;
  catalogRows?: Map<number, number | undefined>;
};
export type CodexCatalogDecodeResult = {
  message?: unknown;
  previewStates?: (boolean | undefined)[];
  projectionError?: { id: number; error: Error };
  pending: boolean;
  failures: { value: string; error: unknown; fragmentCount: number }[];
};

/** The worker retains recovery fragments, but never a completed native page. */
export function createCodexCatalogDecoder() {
  let failures: CodexCatalogDecodeResult["failures"] = [];
  const decoder = new CodexAppServerMessageDecoder((value, error, fragmentCount) => {
    // Redact before bounding: cutting a quoted token first loses its closing quote.
    failures.push({ value: redactCodexAppServerLinePreview(value), error, fragmentCount });
  });
  return (input: CodexCatalogDecodeInput): CodexCatalogDecodeResult => {
    failures = [];
    const parsed = decoder.parse(
      Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength).toString(
        "utf8",
      ),
    );
    const result = projectCodexCatalogMessage(parsed, input);
    result.pending = decoder.hasPending;
    result.failures = failures;
    return result;
  };
}

export function projectCodexCatalogMessage(
  parsed: unknown,
  input: Omit<CodexCatalogDecodeInput, "bytes">,
  cachedPreview?: CodexCatalogPreviewCache,
): CodexCatalogDecodeResult {
  const result: CodexCatalogDecodeResult = { pending: false, failures: [] };
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
  const remainingRows =
    input.route === "unresolved"
      ? input.catalogRows?.has(route.id)
        ? input.catalogRows.get(route.id)
        : 0
      : input.remainingRows;
  try {
    if (!isJsonObject(message.result)) {
      throw new Error("Codex catalog response contains an invalid result");
    }
    if (route.kind === "list") {
      const raw = message.result;
      message.result = projectCodexCatalogNativeResponse(
        raw,
        sanitizeTerminalText,
        cachedPreview,
        remainingRows,
      );
      if (!cachedPreview) {
        result.previewStates = Array.isArray(raw.data)
          ? raw.data
              .slice(0, Array.isArray(message.result.data) ? message.result.data.length : 0)
              .map((row) =>
                isJsonObject(row) && typeof row.preview === "string"
                  ? Boolean(row.preview)
                  : undefined,
              )
          : [];
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
