import { z } from "zod";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./sdk/helpers.ts";

export { hasConfiguredSecretInput, normalizeResolvedSecretInputString, normalizeSecretInputString };

export function buildSecretInputSchema() {
  return z.union([
    z.string(),
    z.object({
      source: z.enum(["env", "file", "exec"]),
      provider: z.string().min(1),
      id: z.string().min(1),
    }),
  ]);
}
