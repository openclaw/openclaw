import { SSEClientTransport, } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadUndiciRuntimeDeps } from "../infra/net/undici-runtime.js";
import { logDebug } from "../logger.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
function attachStderrLogging(serverName, transport) {
    const stderr = transport.stderr;
    if (!stderr || typeof stderr.on !== "function") {
        return undefined;
    }
    const onData = (chunk) => {
        const message = normalizeOptionalString(typeof chunk === "string" ? chunk : String(chunk)) ?? "";
        if (!message) {
            return;
        }
        for (const line of message.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed) {
                logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
            }
        }
    };
    stderr.on("data", onData);
    return () => {
        if (typeof stderr.off === "function") {
            stderr.off("data", onData);
        }
        else if (typeof stderr.removeListener === "function") {
            stderr.removeListener("data", onData);
        }
    };
}
const fetchWithUndici = async (url, init) => (await loadUndiciRuntimeDeps().fetch(url, init));
function buildSseEventSourceFetch(headers) {
    return (url, init) => {
        const sdkHeaders = {};
        if (init?.headers) {
            if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => {
                    sdkHeaders[key] = value;
                });
            }
            else {
                Object.assign(sdkHeaders, init.headers);
            }
        }
        return fetchWithUndici(url, {
            ...init,
            headers: { ...sdkHeaders, ...headers },
        });
    };
}
export function resolveMcpTransport(serverName, rawServer) {
    const resolved = resolveMcpTransportConfig(serverName, rawServer);
    if (!resolved) {
        return null;
    }
    if (resolved.kind === "stdio") {
        const transport = new OpenClawStdioClientTransport({
            command: resolved.command,
            args: resolved.args,
            env: resolved.env,
            cwd: resolved.cwd,
            stderr: "pipe",
        });
        return {
            transport,
            description: resolved.description,
            transportType: "stdio",
            connectionTimeoutMs: resolved.connectionTimeoutMs,
            detachStderr: attachStderrLogging(serverName, transport),
        };
    }
    if (resolved.transportType === "streamable-http") {
        return {
            transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
                requestInit: resolved.headers ? { headers: resolved.headers } : undefined,
            }),
            description: resolved.description,
            transportType: "streamable-http",
            connectionTimeoutMs: resolved.connectionTimeoutMs,
        };
    }
    const headers = {
        ...resolved.headers,
    };
    const hasHeaders = Object.keys(headers).length > 0;
    return {
        transport: new SSEClientTransport(new URL(resolved.url), {
            requestInit: hasHeaders ? { headers } : undefined,
            fetch: fetchWithUndici,
            eventSourceInit: { fetch: buildSseEventSourceFetch(headers) },
        }),
        description: resolved.description,
        transportType: "sse",
        connectionTimeoutMs: resolved.connectionTimeoutMs,
    };
}
