/**
 * Sanitizes inline image payloads mirrored through Codex history so invalid
 * base64 data becomes readable text instead of poisoning replayed transcripts.
 */
import {
  INLINE_IMAGE_DATA_URL_PREFIX,
  sanitizeInlineImageDataUrl,
} from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

export { sanitizeInlineImageDataUrl };

/** Builds the replacement text inserted when an inline image payload is invalid. */
export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}

function sanitizeImageContentRecord(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined {
  if (record.type === "image" && typeof record.data === "string") {
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "image/png";
    const imageUrl = sanitizeInlineImageDataUrl(`data:${mimeType};base64,${record.data}`);
    if (!imageUrl) {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const commaIndex = imageUrl.indexOf(",");
    const metadata = imageUrl.slice(INLINE_IMAGE_DATA_URL_PREFIX.length, commaIndex);
    const mime = metadata.split(";")[0] ?? mimeType;
    const data = imageUrl.slice(commaIndex + 1);
    return mime === record.mimeType && data === record.data
      ? record
      : { ...record, mimeType: mime, data };
  }

  if (record.type === "inputImage" && typeof record.imageUrl === "string") {
    const imageUrl = sanitizeInlineImageDataUrl(record.imageUrl);
    if (!imageUrl) {
      return { type: "inputText", text: invalidInlineImageText(label) };
    }
    return imageUrl === record.imageUrl ? record : { ...record, imageUrl };
  }

  if (record.type === "input_image" && typeof record.image_url === "string") {
    const imageUrl = sanitizeInlineImageDataUrl(record.image_url);
    if (!imageUrl) {
      return { type: "input_text", text: invalidInlineImageText(label) };
    }
    return imageUrl === record.image_url ? record : { ...record, image_url: imageUrl };
  }

  return undefined;
}

/**
 * Sanitizes images without copying unchanged history or mutating its owned snapshot.
 *
 * The walk keeps its own heap stack instead of the call stack, so pathologically
 * nested history is sanitized rather than overflowing the stack. A container that is
 * already being walked is left untouched, which also terminates cyclic payloads.
 */
export function sanitizeCodexHistoryImagePayloads<T>(value: T, label: string): T {
  type Container = unknown[] | Record<string, unknown>;
  type Frame = {
    container: Container;
    isArray: boolean;
    keys: readonly (string | number)[];
    index: number;
    copy: Container | undefined;
  };

  const makeFrame = (container: Container): Frame => ({
    container,
    isArray: Array.isArray(container),
    keys: Array.isArray(container)
      ? Array.from({ length: container.length }, (_, index) => index)
      : Object.keys(container),
    index: 0,
    copy: undefined,
  });

  const ownReplacement = isRecord(value) ? sanitizeImageContentRecord(value, label) : undefined;
  if (ownReplacement) {
    return ownReplacement as T;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return value;
  }

  const inProgress = new WeakSet<object>();
  const root = value as Container;
  const stack: Frame[] = [makeFrame(root)];
  inProgress.add(root);
  let lastResult: unknown = root;
  let lastChanged = false;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index > 0 && lastChanged) {
      const copy = (frame.copy ??= frame.isArray
        ? (frame.container as unknown[]).slice()
        : { ...(frame.container as Record<string, unknown>) });
      (copy as Record<string | number, unknown>)[frame.keys[frame.index - 1]!] = lastResult;
    }

    if (frame.index >= frame.keys.length) {
      stack.pop();
      inProgress.delete(frame.container);
      lastResult = frame.copy ?? frame.container;
      lastChanged = frame.copy !== undefined;
      continue;
    }

    const key = frame.keys[frame.index]!;
    frame.index += 1;
    const child = (frame.container as Record<string | number, unknown>)[key];
    const childReplacement = isRecord(child) ? sanitizeImageContentRecord(child, label) : undefined;
    if (childReplacement) {
      lastResult = childReplacement;
      lastChanged = childReplacement !== child;
      continue;
    }
    if (Array.isArray(child) || isRecord(child)) {
      if (inProgress.has(child)) {
        lastResult = child;
        lastChanged = false;
        continue;
      }
      inProgress.add(child);
      stack.push(makeFrame(child as Container));
      continue;
    }
    lastResult = child;
    lastChanged = false;
  }

  return lastResult as T;
}
