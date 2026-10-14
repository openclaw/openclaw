import { asProtocolRecord } from "../protocol-value-normalization.js";

export const USER_BACKGROUND_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const USER_BACKGROUND_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const USER_BACKGROUND_PREFERENCE_KEY = "ui.background";

/** Personal artwork metadata only. Image bytes and serving URLs never enter preferences. */
export type BackgroundSource =
  | { kind: "none" }
  | { kind: "theme" }
  | { kind: "custom"; assetId: string };

export type BackgroundPreference = {
  source: BackgroundSource;
  /** Missing means faded; keep omission intact for authoritative comparisons. */
  presentation?: "faded" | "full-bleed";
  showOnNewSession: boolean;
  showInSessions: boolean;
  /** Artwork strength, from 0 (hidden) to 1 (full strength). */
  visibility: number;
};

const BACKGROUND_VISIBILITY_MIN = 0;
const BACKGROUND_VISIBILITY_MAX = 1;
export const DEFAULT_BACKGROUND_PREFERENCE: BackgroundPreference = {
  source: { kind: "theme" },
  showOnNewSession: true,
  showInSessions: true,
  visibility: 0.5,
};

/** Opaque identifiers, never paths, URLs, CSS, or data URIs. */
export function isBackgroundAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function normalizeBackgroundPreference(value: unknown): BackgroundPreference | undefined {
  const record = asProtocolRecord(value);
  const input = asProtocolRecord(record?.source);
  if (!record || !input) {
    return undefined;
  }
  let source: BackgroundSource;
  if (input.kind === "none" || input.kind === "theme") {
    source = { kind: input.kind };
  } else if (input.kind === "custom" && isBackgroundAssetId(input.assetId)) {
    source = { kind: "custom", assetId: input.assetId };
  } else {
    return undefined;
  }
  const { presentation, showOnNewSession, showInSessions, visibility } = record;
  if (
    (Object.hasOwn(record, "presentation") &&
      presentation !== "faded" &&
      presentation !== "full-bleed") ||
    typeof showOnNewSession !== "boolean" ||
    typeof showInSessions !== "boolean" ||
    typeof visibility !== "number" ||
    !Number.isFinite(visibility) ||
    visibility < BACKGROUND_VISIBILITY_MIN ||
    visibility > BACKGROUND_VISIBILITY_MAX
  ) {
    return undefined;
  }
  return {
    source,
    ...(presentation === "faded" || presentation === "full-bleed" ? { presentation } : {}),
    showOnNewSession,
    showInSessions,
    visibility,
  };
}

/** First upload opts in only on New Session; replacement retains placement choices. */
export function selectBackgroundSource(
  source: BackgroundSource,
  previous?: BackgroundPreference,
): BackgroundPreference {
  return {
    ...(previous ?? DEFAULT_BACKGROUND_PREFERENCE),
    ...(!previous && source.kind === "custom" ? { showInSessions: false } : {}),
    source,
  };
}
