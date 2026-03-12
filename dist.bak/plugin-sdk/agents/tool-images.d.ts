import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { type ImageSanitizationLimits } from "./image-sanitization.js";
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
export declare function sanitizeContentBlocksImages(blocks: ToolContentBlock[], label: string, opts?: ImageSanitizationLimits): Promise<ToolContentBlock[]>;
export declare function sanitizeImageBlocks(images: ImageContent[], label: string, opts?: ImageSanitizationLimits): Promise<{
    images: ImageContent[];
    dropped: number;
}>;
export declare function sanitizeToolResultImages(result: AgentToolResult<unknown>, label: string, opts?: ImageSanitizationLimits): Promise<AgentToolResult<unknown>>;
export {};
