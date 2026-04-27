import { isMcpConfigRecord, toMcpEnvRecord, toMcpStringArray } from "./mcp-config-shared.js";
export function resolveStdioMcpServerLaunchConfig(raw, options) {
    if (!isMcpConfigRecord(raw)) {
        return { ok: false, reason: "server config must be an object" };
    }
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
        if (typeof raw.url === "string" && raw.url.trim().length > 0) {
            return {
                ok: false,
                reason: "not a stdio server (has url)",
            };
        }
        return { ok: false, reason: "its command is missing" };
    }
    const cwd = typeof raw.cwd === "string" && raw.cwd.trim().length > 0
        ? raw.cwd
        : typeof raw.workingDirectory === "string" && raw.workingDirectory.trim().length > 0
            ? raw.workingDirectory
            : undefined;
    return {
        ok: true,
        config: {
            command: raw.command,
            args: toMcpStringArray(raw.args),
            env: toMcpEnvRecord(raw.env, { onDroppedEntry: options?.onDroppedEnv }),
            cwd,
        },
    };
}
export function describeStdioMcpServerLaunchConfig(config) {
    const args = Array.isArray(config.args) && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
    const cwd = config.cwd ? ` (cwd=${config.cwd})` : "";
    return `${config.command}${args}${cwd}`;
}
