import { normalizeOptionalString } from "../shared/string-coerce.js";

export function normalizeSubagentSessionKey(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}
