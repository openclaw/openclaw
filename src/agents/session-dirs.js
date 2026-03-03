import fs from "node:fs/promises";
import path from "node:path";
export async function resolveAgentSessionDirs(stateDir) {
    const agentsDir = path.join(stateDir, "agents");
    let entries = [];
    try {
        entries = await fs.readdir(agentsDir, { withFileTypes: true });
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return [];
        }
        throw err;
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(agentsDir, entry.name, "sessions"))
        .toSorted((a, b) => a.localeCompare(b));
}
