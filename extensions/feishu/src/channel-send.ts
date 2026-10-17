import {
  adaptMessagePresentationForChannel,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { FEISHU_PRESENTATION_CAPABILITIES } from "./presentation-card.js";

export function resolveFeishuSendAttachmentMedia(
  params: Record<string, unknown>,
): string | undefined {
  const sourceKeys = ["media", "mediaUrl", "path", "filePath", "fileUrl", "image"];
  const candidates: string[] = [];
  let unsupportedPayload = false;
  let unsupportedFile = false;
  let malformed = false;

  const read = (record: Record<string, unknown>, key: string): unknown => {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
    const snakeKey = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    return snakeKey !== key && Object.hasOwn(record, snakeKey) ? record[snakeKey] : undefined;
  };

  const inspect = (record: Record<string, unknown>, nested = false): void => {
    const keys = nested ? [...sourceKeys.slice(0, -1), "url", "image"] : sourceKeys;
    for (const key of keys) {
      const value = read(record, key);
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "string") {
        malformed = true;
        continue;
      }
      const normalized = normalizeOptionalString(value);
      if (normalized) {
        candidates.push(normalized);
      }
    }

    const multiple = read(record, "mediaUrls");
    if (multiple !== undefined) {
      for (const value of Array.isArray(multiple) ? multiple : [multiple]) {
        if (typeof value !== "string") {
          malformed = true;
          continue;
        }
        const normalized = normalizeOptionalString(value);
        if (normalized) {
          candidates.push(normalized);
        }
      }
    }

    for (const key of ["buffer", "base64"]) {
      const value = read(record, key);
      unsupportedPayload ||=
        value !== undefined &&
        (typeof value !== "string" || Boolean(normalizeOptionalString(value)));
    }
    const file = read(record, "file");
    unsupportedFile ||=
      file !== undefined && (typeof file !== "string" || Boolean(normalizeOptionalString(file)));
  };

  inspect(params);
  const attachments = params.attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    malformed = true;
  } else if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!isRecord(attachment)) {
        malformed = true;
      } else {
        inspect(attachment, true);
      }
    }
  }

  if (unsupportedPayload) {
    throw new Error(
      "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; buffer/base64 payloads are not supported.",
    );
  }
  if (malformed) {
    throw new Error(
      "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; a present malformed media source value is not supported — use a string path/URL (or a string array for mediaUrls) instead.",
    );
  }
  if (unsupportedFile) {
    throw new Error(
      "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; the `file` attachment-intent parameter is not supported — use one of the supported media sources instead.",
    );
  }
  const urls = [...new Set(candidates)];
  if (urls.length > 1) {
    throw new Error("Feishu send supports a single media attachment.");
  }
  return urls[0];
}

export function adaptFeishuDirectCopyTextButtons(
  presentation: MessagePresentation,
): MessagePresentation {
  return {
    ...presentation,
    blocks: presentation.blocks.flatMap((block) => {
      if (
        block.type !== "buttons" ||
        !block.buttons.some((button) => button.action?.type === "copy-text")
      ) {
        return [block];
      }
      // The direct action path predates shared presentation adaptation. Reuse
      // that owner so unsupported clipboard actions keep their visible value.
      return adaptMessagePresentationForChannel({
        presentation: { blocks: [block] },
        capabilities: FEISHU_PRESENTATION_CAPABILITIES,
      }).blocks;
    }),
  };
}
