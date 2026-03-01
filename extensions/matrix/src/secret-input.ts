import { hasConfiguredSecretInput, normalizeSecretInputString } from "openclaw/plugin-sdk";
import { z } from "zod";

export { hasConfiguredSecretInput, normalizeSecretInputString };

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
