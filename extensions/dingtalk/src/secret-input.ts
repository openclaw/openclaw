import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/dingtalk";
import { z } from "zod";

export { hasConfiguredSecretInput, normalizeResolvedSecretInputString, normalizeSecretInputString };

// 构建密钥输入的 Zod schema / Build Zod schema for secret input
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
