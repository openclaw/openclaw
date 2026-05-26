import { type ConfigUiHints } from "../shared/config-ui-hints-types.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
/**
 * Sentinel value used to replace sensitive config fields in gateway responses.
 * Write-side handlers (config.set, config.apply, config.patch) detect this
 * sentinel and restore the original value from the on-disk config, so a
 * round-trip through the Web UI does not corrupt credentials.
 */
export declare const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
/**
 * Returns a copy of the config snapshot with all sensitive fields
 * replaced by {@link REDACTED_SENTINEL}. The `hash` is preserved
 * (it tracks config identity, not content).
 *
 * Both `config` (the parsed object) and `raw` (the JSON5 source) are scrubbed
 * so no credential can leak through either path.
 *
 * When `uiHints` are provided, sensitivity is determined from the schema hints.
 * Without hints, falls back to regex-based detection via `isSensitivePath()`.
 */
/**
 * Redact sensitive fields from a plain config object (not a full snapshot).
 * Used by write endpoints (config.set, config.patch, config.apply) to avoid
 * leaking credentials in their responses.
 */
export declare function redactConfigObject<T>(value: T, uiHints?: ConfigUiHints): T;
export declare function redactConfigSnapshot(snapshot: ConfigFileSnapshot, uiHints?: ConfigUiHints): ConfigFileSnapshot;
type RedactionResult = {
    ok: boolean;
    result?: unknown;
    error?: unknown;
    humanReadableMessage?: string;
};
/**
 * Deep-walk `incoming` and replace any {@link REDACTED_SENTINEL} values
 * (on sensitive paths) with the corresponding value from `original`.
 *
 * This is called by config.set / config.apply / config.patch before writing,
 * so that credentials survive a Web UI round-trip unmodified.
 */
export declare function restoreRedactedValues(incoming: unknown, original: unknown, hints?: ConfigUiHints): RedactionResult;
export {};
