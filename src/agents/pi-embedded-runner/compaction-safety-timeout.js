import { withTimeout } from "../../node-host/with-timeout.js";
export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300000;
export async function compactWithSafetyTimeout(compact, timeoutMs = EMBEDDED_COMPACTION_TIMEOUT_MS) {
    return await withTimeout(() => compact(), timeoutMs, "Compaction");
}
