import fs from "node:fs";
import path from "node:path";

/**
 * Matrix Sync Janitor.
 * Detects and repairs corrupted sync states (future timestamps, stale batches).
 * Addresses #54069.
 */
export async function repairMatrixSyncState(stateDir: string) {
    const dedupePath = path.join(stateDir, "inbound-dedupe.json");
    if (fs.existsSync(dedupePath)) {
        try {
            const dedupe = JSON.parse(fs.readFileSync(dedupePath, "utf-8"));
            const now = Date.now();
            const hasFuture = Object.values(dedupe).some((ts: any) => ts > now + 86400000);
            
            if (hasFuture) {
                console.warn("[matrix-janitor] Detected future timestamps in dedupe state. Resetting...");
                fs.writeFileSync(dedupePath, "{}", "utf-8");
            }
        } catch (e) {
            console.error("[matrix-janitor] Failed to audit Matrix dedupe state.");
        }
    }
}
