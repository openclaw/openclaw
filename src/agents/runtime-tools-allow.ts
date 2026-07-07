import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/**
 * A runtime `toolsAllow` policy is "restrictive" only when it actually limits
 * which tools a run may use.
 *
 * Two policies are treated as non-restrictive:
 * - `undefined` — no policy was requested.
 * - a wildcard policy that contains `*` — "all tools allowed", i.e. a no-op.
 *
 * Backends that cannot mediate individual tool calls (CLI backends and ACP
 * dispatch) can safely run a non-restrictive policy, but must refuse a
 * restrictive one because they have no way to enforce it. Keeping this check in
 * one place ensures those backends stay consistent about what they accept.
 */
export function isRestrictiveRuntimeToolsAllow(toolsAllow: string[] | undefined): boolean {
  if (toolsAllow === undefined) {
    return false;
  }
  return !toolsAllow.some((entry) => normalizeLowercaseStringOrEmpty(entry) === "*");
}
