import type { ModelRequestHeaders } from "../types.js";

/** Materialize merged overrides for HTTP clients that cannot consume SDK deletion sentinels. */
export function omitNullRequestHeaders(
  headers: ModelRequestHeaders | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== null) {
      result[name] = value;
    }
  }
  return result;
}
