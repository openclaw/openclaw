import type { OpenClawConfig } from "../../config/types.openclaw.js";
type CommandSurfaceParams = {
    ctx: {
        OriginatingChannel?: string;
        Surface?: string;
        Provider?: string;
        AccountId?: string;
    };
    command: {
        channel?: string;
    };
};
type ChannelAccountParams = {
    cfg: OpenClawConfig;
    ctx: {
        OriginatingChannel?: string;
        Surface?: string;
        Provider?: string;
        AccountId?: string;
    };
    command: {
        channel?: string;
    };
};
export declare function resolveCommandSurfaceChannel(params: CommandSurfaceParams): string;
export declare function resolveChannelAccountId(params: ChannelAccountParams): string;
export {};
