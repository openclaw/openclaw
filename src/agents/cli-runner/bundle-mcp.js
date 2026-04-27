import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfiguredMcpServers } from "../../config/mcp-config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { extractMcpServerMap, loadEnabledBundleMcpConfig, } from "../../plugins/bundle-mcp.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { serializeTomlInlineValue } from "./toml-inline.js";
function resolveBundleMcpMode(mode) {
    return mode ?? "claude-config-file";
}
async function readExternalMcpConfig(configPath) {
    try {
        const raw = JSON.parse(await fs.readFile(configPath, "utf-8"));
        return { mcpServers: extractMcpServerMap(raw) };
    }
    catch {
        return { mcpServers: {} };
    }
}
async function readJsonObject(filePath) {
    try {
        const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
        return raw && typeof raw === "object" && !Array.isArray(raw)
            ? { ...raw }
            : {};
    }
    catch {
        return {};
    }
}
function findMcpConfigPath(args) {
    if (!args?.length) {
        return undefined;
    }
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? "";
        if (arg === "--mcp-config") {
            return normalizeOptionalString(args[i + 1]);
        }
        if (arg.startsWith("--mcp-config=")) {
            return normalizeOptionalString(arg.slice("--mcp-config=".length));
        }
    }
    return undefined;
}
function injectClaudeMcpConfigArgs(args, mcpConfigPath) {
    const next = [];
    for (let i = 0; i < (args?.length ?? 0); i += 1) {
        const arg = args?.[i] ?? "";
        if (arg === "--strict-mcp-config") {
            continue;
        }
        if (arg === "--mcp-config") {
            i += 1;
            continue;
        }
        if (arg.startsWith("--mcp-config=")) {
            continue;
        }
        next.push(arg);
    }
    next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
    return next;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const OPENCLAW_TRANSPORT_TO_BUNDLE_TYPE = {
    "streamable-http": "http",
    http: "http",
    sse: "sse",
    stdio: "stdio",
};
/**
 * Translate the OpenClaw `transport` field on an MCP server entry into the
 * `type` field expected by downstream CLI runners (Claude, Gemini). The
 * OpenClaw config schema (`McpServerConfig.transport`) accepts
 * `"sse" | "streamable-http"`, while Claude Code and Gemini expect
 * `type: "http" | "sse" | "stdio"`. Without this translation, user-defined
 * HTTP MCP servers from `mcp.servers` are written into the bundled CLI config
 * with an unrecognized `transport` key and rejected (or silently treated as
 * stdio) by the downstream CLI.
 *
 * If both `transport` and `type` are set, `type` wins (explicit downstream
 * override). The `transport` key is removed from the result either way so it
 * does not leak into the downstream CLI config.
 */
function translateOpenClawTransportToBundleType(server) {
    const next = { ...server };
    const rawTransport = next.transport;
    delete next.transport;
    if (typeof next.type === "string") {
        return next;
    }
    if (typeof rawTransport === "string") {
        const mapped = OPENCLAW_TRANSPORT_TO_BUNDLE_TYPE[rawTransport];
        if (mapped) {
            next.type = mapped;
        }
    }
    return next;
}
function normalizeStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? [...value]
        : undefined;
}
function normalizeStringRecord(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter((entry) => {
        return typeof entry[1] === "string";
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
function decodeHeaderEnvPlaceholder(value) {
    const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
    if (bearerMatch) {
        return { envVar: bearerMatch[1], bearer: true };
    }
    const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
    if (envMatch) {
        return { envVar: envMatch[1], bearer: false };
    }
    return null;
}
function applyCommonServerConfig(next, server) {
    if (typeof server.command === "string") {
        next.command = server.command;
    }
    const args = normalizeStringArray(server.args);
    if (args) {
        next.args = args;
    }
    const env = normalizeStringRecord(server.env);
    if (env) {
        next.env = env;
    }
    if (typeof server.cwd === "string") {
        next.cwd = server.cwd;
    }
    if (typeof server.url === "string") {
        next.url = server.url;
    }
}
function isOpenClawLoopbackMcpServer(name, server) {
    return (name === "openclaw" &&
        typeof server.url === "string" &&
        /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url));
}
function normalizeCodexServerConfig(name, server) {
    const next = {};
    applyCommonServerConfig(next, server);
    if (isOpenClawLoopbackMcpServer(name, server)) {
        next.default_tools_approval_mode = "approve";
    }
    const httpHeaders = normalizeStringRecord(server.headers);
    if (httpHeaders) {
        const staticHeaders = {};
        const envHeaders = {};
        for (const [name, value] of Object.entries(httpHeaders)) {
            const decoded = decodeHeaderEnvPlaceholder(value);
            if (!decoded) {
                staticHeaders[name] = value;
                continue;
            }
            if (decoded.bearer && normalizeOptionalLowercaseString(name) === "authorization") {
                next.bearer_token_env_var = decoded.envVar;
                continue;
            }
            envHeaders[name] = decoded.envVar;
        }
        if (Object.keys(staticHeaders).length > 0) {
            next.http_headers = staticHeaders;
        }
        if (Object.keys(envHeaders).length > 0) {
            next.env_http_headers = envHeaders;
        }
    }
    return next;
}
function resolveEnvPlaceholder(value, inheritedEnv) {
    const decoded = decodeHeaderEnvPlaceholder(value);
    if (!decoded) {
        return value;
    }
    const resolved = inheritedEnv?.[decoded.envVar] ?? process.env[decoded.envVar] ?? "";
    return decoded.bearer ? `Bearer ${resolved}` : resolved;
}
function normalizeGeminiServerConfig(server, inheritedEnv) {
    const next = {};
    applyCommonServerConfig(next, server);
    if (typeof server.type === "string") {
        next.type = server.type;
    }
    const headers = normalizeStringRecord(server.headers);
    if (headers) {
        next.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [
            name,
            resolveEnvPlaceholder(value, inheritedEnv),
        ]));
    }
    if (typeof server.trust === "boolean") {
        next.trust = server.trust;
    }
    return next;
}
function injectCodexMcpConfigArgs(args, config) {
    const overrides = serializeTomlInlineValue(Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => [
        name,
        normalizeCodexServerConfig(name, server),
    ])));
    return [...(args ?? []), "-c", `mcp_servers=${overrides}`];
}
async function writeGeminiSystemSettings(mergedConfig, inheritedEnv) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-mcp-"));
    const settingsPath = path.join(tempDir, "settings.json");
    const existingSettingsPath = inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    const base = typeof existingSettingsPath === "string" && existingSettingsPath.trim()
        ? await readJsonObject(existingSettingsPath)
        : {};
    const normalizedConfig = {
        mcpServers: Object.fromEntries(Object.entries(mergedConfig.mcpServers).map(([name, server]) => [
            name,
            normalizeGeminiServerConfig(server, inheritedEnv),
        ])),
    };
    const settings = applyMergePatch(base, {
        mcp: {
            allowed: Object.keys(normalizedConfig.mcpServers),
        },
        mcpServers: normalizedConfig.mcpServers,
    });
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    return {
        env: {
            ...inheritedEnv,
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
        },
        cleanup: async () => {
            await fs.rm(tempDir, { recursive: true, force: true });
        },
    };
}
function sortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => sortJsonValue(entry));
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(Object.keys(value)
        .toSorted()
        .map((key) => [key, sortJsonValue(value[key])]));
}
function normalizeOpenClawLoopbackUrl(value) {
    const match = /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(\/mcp)$/.exec(value.trim()) ?? undefined;
    if (!match) {
        return value;
    }
    return `${match[1]}:<openclaw-loopback>${match[2]}`;
}
function canonicalizeBundleMcpConfigForResume(config) {
    const canonicalServers = Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => {
        if (name !== "openclaw" || typeof server.url !== "string") {
            return [name, sortJsonValue(server)];
        }
        return [
            name,
            sortJsonValue({
                ...server,
                url: normalizeOpenClawLoopbackUrl(server.url),
            }),
        ];
    }));
    return {
        mcpServers: sortJsonValue(canonicalServers),
    };
}
async function prepareModeSpecificBundleMcpConfig(params) {
    const serializedConfig = `${JSON.stringify(params.mergedConfig, null, 2)}\n`;
    const mcpConfigHash = crypto.createHash("sha256").update(serializedConfig).digest("hex");
    const serializedResumeConfig = `${JSON.stringify(canonicalizeBundleMcpConfigForResume(params.mergedConfig), null, 2)}\n`;
    const mcpResumeHash = crypto.createHash("sha256").update(serializedResumeConfig).digest("hex");
    if (params.mode === "codex-config-overrides") {
        return {
            backend: {
                ...params.backend,
                args: injectCodexMcpConfigArgs(params.backend.args, params.mergedConfig),
                resumeArgs: injectCodexMcpConfigArgs(params.backend.resumeArgs ?? params.backend.args ?? [], params.mergedConfig),
            },
            mcpConfigHash,
            mcpResumeHash,
            env: params.env,
        };
    }
    if (params.mode === "gemini-system-settings") {
        const settings = await writeGeminiSystemSettings(params.mergedConfig, params.env);
        return {
            backend: params.backend,
            mcpConfigHash,
            mcpResumeHash,
            env: settings.env,
            cleanup: settings.cleanup,
        };
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
    const mcpConfigPath = path.join(tempDir, "mcp.json");
    await fs.writeFile(mcpConfigPath, serializedConfig, "utf-8");
    return {
        backend: {
            ...params.backend,
            args: injectClaudeMcpConfigArgs(params.backend.args, mcpConfigPath),
            resumeArgs: injectClaudeMcpConfigArgs(params.backend.resumeArgs ?? params.backend.args ?? [], mcpConfigPath),
        },
        mcpConfigHash,
        mcpResumeHash,
        env: params.env,
        cleanup: async () => {
            await fs.rm(tempDir, { recursive: true, force: true });
        },
    };
}
export async function prepareCliBundleMcpConfig(params) {
    if (!params.enabled) {
        return { backend: params.backend, env: params.env };
    }
    const mode = resolveBundleMcpMode(params.mode);
    const existingMcpConfigPath = mode === "claude-config-file"
        ? (findMcpConfigPath(params.backend.resumeArgs) ?? findMcpConfigPath(params.backend.args))
        : undefined;
    let mergedConfig = { mcpServers: {} };
    if (existingMcpConfigPath) {
        const resolvedExistingPath = path.isAbsolute(existingMcpConfigPath)
            ? existingMcpConfigPath
            : path.resolve(params.workspaceDir, existingMcpConfigPath);
        mergedConfig = applyMergePatch(mergedConfig, await readExternalMcpConfig(resolvedExistingPath));
    }
    const bundleConfig = loadEnabledBundleMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.config,
    });
    for (const diagnostic of bundleConfig.diagnostics) {
        params.warn?.(`bundle MCP skipped for ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
    mergedConfig = applyMergePatch(mergedConfig, bundleConfig.config);
    const configuredMcp = normalizeConfiguredMcpServers(params.config?.mcp?.servers);
    if (Object.keys(configuredMcp).length > 0) {
        const translatedConfiguredMcp = Object.fromEntries(Object.entries(configuredMcp).map(([name, server]) => [
            name,
            translateOpenClawTransportToBundleType(server),
        ]));
        const existingMcpServers = mergedConfig.mcpServers;
        mergedConfig = {
            ...mergedConfig,
            mcpServers: existingMcpServers
                ? { ...existingMcpServers, ...translatedConfiguredMcp }
                : translatedConfiguredMcp,
        };
    }
    if (params.additionalConfig) {
        mergedConfig = applyMergePatch(mergedConfig, params.additionalConfig);
    }
    return await prepareModeSpecificBundleMcpConfig({
        mode,
        backend: params.backend,
        mergedConfig,
        env: params.env,
    });
}
