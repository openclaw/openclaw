import { logWarn } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { describeHttpMcpServerLaunchConfig, resolveHttpMcpServerLaunchConfig, } from "./mcp-http.js";
import { describeStdioMcpServerLaunchConfig, resolveStdioMcpServerLaunchConfig, } from "./mcp-stdio.js";
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
function getConnectionTimeoutMs(rawServer) {
    if (rawServer &&
        typeof rawServer === "object" &&
        typeof rawServer.connectionTimeoutMs === "number" &&
        rawServer.connectionTimeoutMs > 0) {
        return rawServer.connectionTimeoutMs;
    }
    return DEFAULT_CONNECTION_TIMEOUT_MS;
}
function getRequestedTransport(rawServer) {
    if (!rawServer ||
        typeof rawServer !== "object" ||
        typeof rawServer.transport !== "string") {
        return "";
    }
    return normalizeLowercaseStringOrEmpty(rawServer.transport);
}
function resolveHttpTransportConfig(serverName, rawServer, transportType) {
    const launch = resolveHttpMcpServerLaunchConfig(rawServer, {
        transportType,
        onDroppedHeader: (key) => {
            logWarn(`bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`);
        },
        onMalformedHeaders: () => {
            logWarn(`bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`);
        },
    });
    if (!launch.ok) {
        return null;
    }
    return {
        kind: "http",
        transportType: launch.config.transportType,
        url: launch.config.url,
        headers: launch.config.headers,
        description: describeHttpMcpServerLaunchConfig(launch.config),
        connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
    };
}
export function resolveMcpTransportConfig(serverName, rawServer) {
    const logServerName = sanitizeForLog(serverName);
    const requestedTransport = getRequestedTransport(rawServer);
    const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer, {
        onDroppedEnv: (key) => {
            logWarn(`bundle-mcp: server "${logServerName}": env "${sanitizeForLog(key)}" is blocked for stdio startup safety and was ignored.`);
        },
    });
    if (stdioLaunch.ok) {
        return {
            kind: "stdio",
            transportType: "stdio",
            command: stdioLaunch.config.command,
            args: stdioLaunch.config.args,
            env: stdioLaunch.config.env,
            cwd: stdioLaunch.config.cwd,
            description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
            connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
        };
    }
    if (requestedTransport &&
        requestedTransport !== "sse" &&
        requestedTransport !== "streamable-http") {
        logWarn(`bundle-mcp: skipped server "${logServerName}" because transport "${sanitizeForLog(requestedTransport)}" is not supported.`);
        return null;
    }
    if (requestedTransport === "streamable-http") {
        const httpTransport = resolveHttpTransportConfig(serverName, rawServer, "streamable-http");
        if (httpTransport) {
            return httpTransport;
        }
    }
    const sseTransport = resolveHttpTransportConfig(serverName, rawServer, "sse");
    if (sseTransport) {
        return sseTransport;
    }
    const httpLaunch = resolveHttpMcpServerLaunchConfig(rawServer);
    const httpReason = httpLaunch.ok ? "not an HTTP MCP server" : httpLaunch.reason;
    logWarn(`bundle-mcp: skipped server "${logServerName}" because ${stdioLaunch.reason} and ${httpReason}.`);
    return null;
}
