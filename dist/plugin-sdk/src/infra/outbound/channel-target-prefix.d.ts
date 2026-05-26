export type ChannelTargetProviderPrefix = {
    prefix: string;
    channel: string;
};
export declare function resolveTargetPrefixedChannel(raw?: string | null): string | undefined;
export declare function validateTargetProviderPrefix(params: {
    channel: string;
    to?: string | null;
}): Error | undefined;
