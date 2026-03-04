import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/zalo";
import { z } from "zod";

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
