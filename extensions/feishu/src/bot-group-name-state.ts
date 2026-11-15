import { createStaleWhileRevalidateCache } from "openclaw/plugin-sdk/collection-runtime";

export const feishuGroupNameCache = createStaleWhileRevalidateCache<string | undefined>({
  maxEntries: 500,
  maxPending: Infinity,
  ttlMs: 30 * 60_000,
});
