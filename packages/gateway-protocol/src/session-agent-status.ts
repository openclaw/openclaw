import { isSelfContainedSvg } from "./svg-image.js";

export const SESSION_AGENT_ATTENTION_ICON_IDS = [
  "hand",
  "key",
  "alert",
  "flag",
  "lock",
  "hourglass",
] as const;

export type SessionAgentAttentionIconId = (typeof SESSION_AGENT_ATTENTION_ICON_IDS)[number];

// Palette matches Claude Code's /color names exactly so imported sessions keep
// their color 1:1; clients render theme-tuned hues per name, never raw values.
export const SESSION_COLOR_IDS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export type SessionColorId = (typeof SESSION_COLOR_IDS)[number];

export function normalizeSessionColorValue(value: string): SessionColorId | null {
  const normalized = value.trim().toLowerCase();
  return SESSION_COLOR_IDS.find((id) => id === normalized) ?? null;
}

export const SESSION_ICON_GLYPH_IDS = [
  "braces",
  "book",
  "monitor",
  "bot",
  "kanban",
  "coins",
] as const;

export type SessionIconGlyphId = (typeof SESSION_ICON_GLYPH_IDS)[number];

const SESSION_ICON_GLYPH_ID_SET = new Set<string>(SESSION_ICON_GLYPH_IDS);
export const SESSION_ICON_SVG_MAX_BYTES = 16 * 1024;
export const SESSION_ICON_SVG_DATA_URL_PREFIX = "data:image/svg+xml,";
const SVG_DATA_URL_RE = /^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,/iu;

function normalizeSessionSvgIcon(value: string): string | null {
  // Bound encoded input before decoding; a UTF-8 byte needs at most three URL characters.
  if (value.length > SESSION_ICON_SVG_MAX_BYTES * 3 + 64) {
    return null;
  }
  const dataUrl = SVG_DATA_URL_RE.exec(value);
  let source = value;
  try {
    if (dataUrl) {
      const payload = value.slice(dataUrl[0].length);
      source = dataUrl[1]
        ? new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)),
          )
        : decodeURIComponent(payload);
    }
    source = source.trim();
    if (
      new TextEncoder().encode(source).byteLength > SESSION_ICON_SVG_MAX_BYTES ||
      !isSelfContainedSvg(source)
    ) {
      return null;
    }
    return `${SESSION_ICON_SVG_DATA_URL_PREFIX}${encodeURIComponent(source)}`;
  } catch {
    return null;
  }
}
// Anchored RGI_Emoji admits exactly one recommended-for-interchange emoji
// sequence (ZWJ families, flags, keycaps included) and nothing else. Constructed
// lazily: the TypeScript target rejects literal `v` flags, and this module also
// loads in the browser (session-menu picker), where a pre-Unicode-Sets engine
// must not throw at module evaluation. Server runtimes (Node 22+) always take
// the exact path; `null` marks an engine without `v`-flag support.
let sessionIconRe: RegExp | null | undefined;
function sessionIconPattern(): RegExp | null {
  if (sessionIconRe === undefined) {
    try {
      sessionIconRe = new RegExp("^\\p{RGI_Emoji}$", "v");
    } catch {
      sessionIconRe = null;
    }
  }
  return sessionIconRe;
}

function isSingleNonAsciiGrapheme(value: string): boolean {
  if (value.length > 16 || /^[!-~]$/u.test(value)) {
    return false;
  }
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1;
}

export function normalizeSessionIconValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (SESSION_ICON_GLYPH_ID_SET.has(normalized)) {
    return normalized;
  }
  if (normalized.startsWith("<") || /^data:/iu.test(normalized)) {
    return normalizeSessionSvgIcon(normalized);
  }
  const pattern = sessionIconPattern();
  // Pre-Unicode-Sets browsers get the older grapheme heuristic as client-side
  // pre-validation only; the Gateway re-validates with the exact RGI pattern.
  const accepted = pattern ? pattern.test(normalized) : isSingleNonAsciiGrapheme(normalized);
  return accepted ? normalized : null;
}

export type SessionAgentStatus = {
  note: string;
  expiresAt: number;
  attention?: SessionAgentAttentionIconId;
};
