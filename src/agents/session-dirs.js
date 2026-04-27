import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
function mapAgentSessionDirs(agentsDir, entries) {
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(agentsDir, entry.name, "sessions"))
        .toSorted((a, b) => a.localeCompare(b));
}
export async function resolveAgentSessionDirsFromAgentsDir(agentsDir) {
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
    return mapAgentSessionDirs(agentsDir, entries);
}
export function resolveAgentSessionDirsFromAgentsDirSync(agentsDir) {
    let entries = [];
    try {
        entries = fsSync.readdirSync(agentsDir, { withFileTypes: true });
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return [];
        }
        throw err;
    }
    return mapAgentSessionDirs(agentsDir, entries);
}
export async function resolveAgentSessionDirs(stateDir) {
    return await resolveAgentSessionDirsFromAgentsDir(path.join(stateDir, "agents"));
}
