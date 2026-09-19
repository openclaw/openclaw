/**
 * Sanitizes inline image payloads mirrored through Codex history so invalid
 * base64 data becomes readable text instead of poisoning replayed transcripts.
 */
import {
  INLINE_IMAGE_DATA_URL_PREFIX,
  sanitizeInlineImageDataUrl as sanitizeSharedInlineImageDataUrl,
} from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";

/** Validates and normalizes an inline image data URL for Codex history payloads. */
export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeSharedInlineImageDataUrl(imageUrl);
}

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

type SanitizerSlot = {
  parent: SanitizerContainerFrame;
  key: string | number;
};

type SanitizerContainerFrame = {
  kind: "container";
  original: unknown[] | Record<string, unknown>;
  keys: Array<string | number>;
  index: number;
  children: Map<string | number, unknown>;
  slot?: SanitizerSlot;
};

type SanitizerFrame =
  | { kind: "visit"; value: unknown; slot?: SanitizerSlot }
  | SanitizerContainerFrame;

function assignSanitizedResult(
  slot: SanitizerSlot | undefined,
  result: unknown,
  setRoot: (value: unknown) => void,
): void {
  if (slot) {
    slot.parent.children.set(slot.key, result);
  } else {
    setRoot(result);
  }
}

/** Sanitizes images without copying unchanged history or mutating its owned snapshot. */
export function sanitizeCodexHistoryImagePayloads<T>(value: T, label: string): T {
  let result: unknown;
  const stack: SanitizerFrame[] = [{ kind: "visit", value }];

  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (!frame) {
      break;
    }
    if (frame.kind === "visit") {
      stack.pop();
      if (Array.isArray(frame.value)) {
        stack.push({
          kind: "container",
          original: frame.value,
          keys: Array.from({ length: frame.value.length }, (_, index) => index),
          index: 0,
          children: new Map(),
          slot: frame.slot,
        });
        continue;
      }

      if (!isRecord(frame.value)) {
        assignSanitizedResult(frame.slot, frame.value, (next) => {
          result = next;
        });
        continue;
      }

      const imageRecord = sanitizeImageContentRecord(frame.value, label);
      if (imageRecord) {
        assignSanitizedResult(frame.slot, imageRecord, (next) => {
          result = next;
        });
        continue;
      }

      stack.push({
        kind: "container",
        original: frame.value,
        keys: Object.keys(frame.value),
        index: 0,
        children: new Map(),
        slot: frame.slot,
      });
      continue;
    }

    if (frame.index < frame.keys.length) {
      const key = frame.keys[frame.index++];
      if (key === undefined) {
        continue;
      }
      if (Array.isArray(frame.original) && !Object.hasOwn(frame.original, key)) {
        continue;
      }
      const child = Array.isArray(frame.original)
        ? frame.original[key as number]
        : frame.original[key as string];
      stack.push({ kind: "visit", value: child, slot: { parent: frame, key } });
      continue;
    }

    stack.pop();
    let next: unknown[] | Record<string, unknown> | undefined;
    for (const key of frame.keys) {
      if (!frame.children.has(key)) {
        continue;
      }
      const child = frame.children.get(key);
      const originalChild = Array.isArray(frame.original)
        ? frame.original[key as number]
        : frame.original[key as string];
      if (child !== originalChild) {
        const clone =
          next ?? (Array.isArray(frame.original) ? frame.original.slice() : { ...frame.original });
        next = clone;
        if (Array.isArray(clone)) {
          clone[key as number] = child;
        } else {
          clone[key as string] = child;
        }
      }
    }
    assignSanitizedResult(frame.slot, next ?? frame.original, (root) => {
      result = root;
    });
  }

  return result as T;
}
