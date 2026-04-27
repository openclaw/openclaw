export function resolveSessionLane(key) {
    const cleaned = key.trim() || "main" /* CommandLane.Main */;
    return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}
export function resolveGlobalLane(lane) {
    const cleaned = lane?.trim();
    // Cron jobs hold the cron lane slot; inner operations must use nested to avoid deadlock.
    if (cleaned === "cron" /* CommandLane.Cron */) {
        return "nested" /* CommandLane.Nested */;
    }
    return cleaned ? cleaned : "main" /* CommandLane.Main */;
}
export function resolveEmbeddedSessionLane(key) {
    return resolveSessionLane(key);
}
