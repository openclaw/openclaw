import { extensionForMime } from "openclaw/plugin-sdk/media-mime";

export function resolveWhatsAppDocumentFileName(params: {
  fileName?: string;
  mimetype?: string;
}): string {
  const fallbackName = `file${extensionForMime(params.mimetype) ?? ""}`;
  const stripped = stripAsciiControlCharacters(params.fileName ?? "").trim();
  return stripped || fallbackName;
}

function stripAsciiControlCharacters(value: string): string {
  let stripped = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) {
      stripped += char;
    }
  }
  return stripped;
}
