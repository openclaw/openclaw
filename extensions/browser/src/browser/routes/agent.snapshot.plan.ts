import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedBrowserProfile } from "../config.js";
import {
  DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH,
  DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "../constants.js";
import { resolveBrowserEngine } from "../engines/registry.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { normalizeBrowserTimerDelayMs } from "../timer-delay.js";
import { toBoolean, toStringOrEmpty } from "./utils.js";

export function resolveSnapshotPlan(params: {
  profile: ResolvedBrowserProfile;
  query: Record<string, unknown>;
  hasPlaywright: boolean;
}) {
  const mode = params.query.mode === "efficient" ? "efficient" : undefined;
  const labels = toBoolean(params.query.labels) ?? undefined;
  const urls = toBoolean(params.query.urls) ?? undefined;
  const explicitFormat =
    params.query.format === "aria" ? "aria" : params.query.format === "ai" ? "ai" : undefined;
  const format =
    explicitFormat ??
    (mode === "efficient" ||
    getBrowserProfileCapabilities(params.profile).usesChromeMcp ||
    params.hasPlaywright
      ? "ai"
      : "aria");
  const limit = parseStrictPositiveInteger(params.query.limit);
  const maxCharsRaw = Object.hasOwn(params.query, "maxChars")
    ? parseStrictNonNegativeInteger(params.query.maxChars)
    : undefined;
  const maxChars = maxCharsRaw !== undefined && maxCharsRaw > 0 ? maxCharsRaw : undefined;
  const resolvedMaxChars =
    format !== "ai"
      ? undefined
      : maxCharsRaw !== undefined
        ? maxChars
        : mode === "efficient"
          ? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS;
  const interactiveRaw = toBoolean(params.query.interactive);
  const compactRaw = toBoolean(params.query.compact);
  const depthRaw = parseStrictNonNegativeInteger(params.query.depth);
  const refsModeRaw = toStringOrEmpty(params.query.refs);
  const refsMode: "aria" | "role" | undefined =
    refsModeRaw === "aria"
      ? "aria"
      : refsModeRaw === "role"
        ? "role"
        : resolveBrowserEngine(params.profile.engine).defaultSnapshotRefs;
  const interactive = interactiveRaw ?? (mode === "efficient" ? true : undefined);
  const compact = compactRaw ?? (mode === "efficient" ? true : undefined);
  const depth =
    depthRaw ?? (mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH : undefined);
  const selectorValue = normalizeOptionalString(toStringOrEmpty(params.query.selector));
  const frameSelectorValue = normalizeOptionalString(toStringOrEmpty(params.query.frame));
  const timeoutMsRaw = parseStrictPositiveInteger(params.query.timeoutMs);
  const timeoutMs =
    timeoutMsRaw !== undefined ? normalizeBrowserTimerDelayMs(timeoutMsRaw) : undefined;

  return {
    format,
    mode,
    labels,
    urls,
    limit,
    resolvedMaxChars,
    interactive,
    compact,
    depth,
    refsMode,
    selectorValue,
    frameSelectorValue,
    timeoutMs,
    wantsRoleSnapshot:
      labels === true ||
      urls === true ||
      mode === "efficient" ||
      interactive === true ||
      compact === true ||
      depth !== undefined ||
      Boolean(selectorValue) ||
      Boolean(frameSelectorValue),
  };
}
