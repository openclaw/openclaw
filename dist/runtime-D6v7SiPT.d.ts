import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { AgentToolResult } from "@earendil-works/pi-agent-core";

//#region extensions/discord/src/actions/runtime.d.ts
declare function handleDiscordAction(params: Record<string, unknown>, cfg: OpenClawConfig, options?: {
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<AgentToolResult<unknown>>;
//#endregion
export { handleDiscordAction as t };