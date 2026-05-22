import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type OpenClawConfig } from "../runtime-api.js";
export declare function handleDiscordAction(params: Record<string, unknown>, cfg: OpenClawConfig, options?: {
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
        workspaceDir?: string;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<AgentToolResult<unknown>>;
