import fs from "node:fs/promises";
import path from "node:path";
function isSessionHeader(entry) {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    const record = entry;
    return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}
export async function repairSessionFileIfNeeded(params) {
    const sessionFile = params.sessionFile.trim();
    if (!sessionFile) {
        return { repaired: false, droppedLines: 0, reason: "missing session file" };
    }
    let content;
    try {
        content = await fs.readFile(sessionFile, "utf-8");
    }
    catch (err) {
        const code = err?.code;
        if (code === "ENOENT") {
            return { repaired: false, droppedLines: 0, reason: "missing session file" };
        }
        const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
        params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
        return { repaired: false, droppedLines: 0, reason };
    }
    const lines = content.split(/\r?\n/);
    const entries = [];
    let droppedLines = 0;
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        try {
            const entry = JSON.parse(line);
            entries.push(entry);
        }
        catch {
            droppedLines += 1;
        }
    }
    if (entries.length === 0) {
        return { repaired: false, droppedLines, reason: "empty session file" };
    }
    if (!isSessionHeader(entries[0])) {
        params.warn?.(`session file repair skipped: invalid session header (${path.basename(sessionFile)})`);
        return { repaired: false, droppedLines, reason: "invalid session header" };
    }
    if (droppedLines === 0) {
        return { repaired: false, droppedLines: 0 };
    }
    const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
    const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
    try {
        const stat = await fs.stat(sessionFile).catch(() => null);
        await fs.writeFile(backupPath, content, "utf-8");
        if (stat) {
            await fs.chmod(backupPath, stat.mode);
        }
        await fs.writeFile(tmpPath, cleaned, "utf-8");
        if (stat) {
            await fs.chmod(tmpPath, stat.mode);
        }
        await fs.rename(tmpPath, sessionFile);
    }
    catch (err) {
        try {
            await fs.unlink(tmpPath);
        }
        catch (cleanupErr) {
            params.warn?.(`session file repair cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(tmpPath)})`);
        }
        return {
            repaired: false,
            droppedLines,
            reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
        };
    }
    params.warn?.(`session file repaired: dropped ${droppedLines} malformed line(s) (${path.basename(sessionFile)})`);
    return { repaired: true, droppedLines, backupPath };
}
