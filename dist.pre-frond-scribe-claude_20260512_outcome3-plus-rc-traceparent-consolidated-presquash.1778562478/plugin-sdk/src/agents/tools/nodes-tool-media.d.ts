import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { GatewayCallOptions } from "./gateway.js";
export declare const MEDIA_INVOKE_ACTIONS: {
    readonly "camera.snap": "camera_snap";
    readonly "camera.clip": "camera_clip";
    readonly "photos.latest": "photos_latest";
    readonly "screen.record": "screen_record";
    readonly "file.fetch": "file_fetch";
    readonly "dir.list": "dir_list";
    readonly "dir.fetch": "dir_fetch";
    readonly "file.write": "file_write";
};
export declare const POLICY_REDIRECT_INVOKE_COMMANDS: ReadonlySet<string>;
export type NodeMediaAction = "camera_snap" | "photos_latest" | "camera_clip" | "screen_record";
type ExecuteNodeMediaActionParams = {
    action: NodeMediaAction;
    params: Record<string, unknown>;
    gatewayOpts: GatewayCallOptions;
    modelHasVision?: boolean;
    imageSanitization: ImageSanitizationLimits;
};
export declare function executeNodeMediaAction(input: ExecuteNodeMediaActionParams): Promise<AgentToolResult<unknown>>;
export {};
