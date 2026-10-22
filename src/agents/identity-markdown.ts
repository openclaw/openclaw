import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isAvatarDataUrl } from "../shared/avatar-policy.js";

// IDENTITY.md may contain the supported 2 MiB avatar encoded as a roughly
// 2.7 MiB data URL. Keep bounded headroom for the remaining identity fields.
export const MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

function normalizeIdentityLabel(label: string): string {
  return normalizeLowercaseStringOrEmpty(label.replace(/[*_`]/g, ""));
}

export function parseIdentityLine(line: string): { label: string; value: string } | undefined {
  const cleaned = line
    .trim()
    .replace(/^\s*-\s*/, "")
    .replace(/^([*_`]+)([A-Za-z]+):\1/u, "$2:");
  const colonIndex = cleaned.indexOf(":");
  return colonIndex === -1
    ? undefined
    : {
        label: normalizeIdentityLabel(cleaned.slice(0, colonIndex)),
        value: cleaned.slice(colonIndex + 1),
      };
}

export function stripIdentityValueDecoration(value: string): string {
  let cleaned = value.trim();
  for (;;) {
    const paired = cleaned.match(/^(\*{1,2}|_{1,2}|`+)([\s\S]+)\1$/u);
    const marker = paired?.[1];
    const inner = paired?.[2];
    if (!marker || inner === undefined) {
      return cleaned;
    }
    cleaned = inner.trim();
    // Code spans preserve their contents, including literal emphasis markers.
    if (marker.startsWith("`")) {
      return cleaned;
    }
  }
}

/** Keep inline image bytes in storage and display, rather than model instructions. */
export function projectIdentityMarkdownForPrompt(content: string): string {
  return content.replace(/[^\r\n]+/gu, (line) => {
    const parsed = parseIdentityLine(line);
    return parsed?.label === "avatar" && isAvatarDataUrl(stripIdentityValueDecoration(parsed.value))
      ? "- Avatar: [inline image omitted]"
      : line;
  });
}
