import type { UpdateChannel } from "../infra/update-channels.js";
export type ChannelInstallSpecs = {
    installSpec: string;
    recordSpec: string;
    fallbackSpec?: string;
    fallbackLabel?: string;
};
export declare function resolveNpmInstallSpecsForUpdateChannel(params: {
    spec: string;
    updateChannel?: UpdateChannel;
}): ChannelInstallSpecs;
export declare function resolveClawHubInstallSpecsForUpdateChannel(params: {
    spec: string;
    updateChannel?: UpdateChannel;
}): ChannelInstallSpecs;
