import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackFile } from "./types.js";

export function formatSlackFileReference(file: SlackFile | undefined): string {
  const name = normalizeOptionalString(file?.name) ?? "file";
  const fileId = normalizeOptionalString(file?.id);
  return fileId ? `${name} (fileId: ${fileId})` : name;
}

export function formatSlackFileReferenceList(files: readonly SlackFile[] | undefined): string {
  if (!files?.length) {
    return "file";
  }
  let text = "";
  for (const file of files) {
    const reference = formatSlackFileReference(file);
    text = text ? `${text}, ${reference}` : reference;
  }
  return text;
}
