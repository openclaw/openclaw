import type { UpdateChannel } from "../infra/update-channels.js";
export declare function resolveChannelAwareNpmSpec(params: {
    npmSpec?: string;
    packageName?: string;
    packageVersion?: string;
    channel?: UpdateChannel;
}): string | undefined;
