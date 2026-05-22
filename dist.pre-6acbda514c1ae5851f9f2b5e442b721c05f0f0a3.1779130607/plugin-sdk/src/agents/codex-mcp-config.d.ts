import { type BundleMcpConfig, type BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import type { CodexBundleMcpThreadConfig, CodexMcpServersConfig, LoadCodexBundleMcpThreadConfigParams } from "./codex-mcp-config.types.js";
export type { CodexBundleMcpThreadConfig, CodexMcpServersConfig, LoadCodexBundleMcpThreadConfigParams, } from "./codex-mcp-config.types.js";
export declare function normalizeCodexMcpServerConfig(name: string, server: BundleMcpServerConfig): Record<string, unknown>;
export declare function buildCodexMcpServersConfig(config: BundleMcpConfig): CodexMcpServersConfig;
export declare function loadCodexBundleMcpThreadConfig(params: LoadCodexBundleMcpThreadConfigParams): CodexBundleMcpThreadConfig;
