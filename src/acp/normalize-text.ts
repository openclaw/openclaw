import { normalizeOptionalString } from "../shared/string-coerce.js";

export function normalizeText(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}
