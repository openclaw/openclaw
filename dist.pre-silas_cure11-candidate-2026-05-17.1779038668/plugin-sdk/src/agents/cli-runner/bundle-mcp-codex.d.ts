import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { BundleMcpConfig } from "../../plugins/bundle-mcp.js";
type CodexThreadConfigValue = string | number | boolean | null | CodexThreadConfigValue[] | {
    [key: string]: CodexThreadConfigValue;
};
type CodexThreadConfigObject = {
    [key: string]: CodexThreadConfigValue;
};
type CodexUserMcpServersProjectionOptions = {
    agentId?: string;
};
export declare function injectCodexMcpConfigArgs(args: string[] | undefined, config: BundleMcpConfig): string[];
/**
 * Codex app-server runtime (extensions/codex) receives its thread config as a
 * JSON object through JSON-RPC `thread/start`/`thread/resume`, not as `-c` CLI
 * args. This returns a thread-config patch projecting user-configured
 * `cfg.mcp.servers` entries into Codex's `mcp_servers` table using the same
 * per-server normalization the CLI path uses, so app-server agents see the
 * same user MCP servers the CLI runtime exposes via `injectCodexMcpConfigArgs`.
 *
 * Only user-configured servers (`cfg.mcp.servers`) are projected. Plugin-
 * curated app-server apps are already attached separately through the codex
 * plugin thread-config `apps` patch, so they must not be re-projected here.
 */
export declare function buildCodexUserMcpServersThreadConfigPatch(cfg: OpenClawConfig | undefined, options?: CodexUserMcpServersProjectionOptions): {
    mcp_servers: CodexThreadConfigObject;
} | undefined;
export {};
