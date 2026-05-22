type SlackModalPrivateMetadata = {
    sessionKey?: string;
    channelId?: string;
    channelType?: string;
    userId?: string;
    pluginInteractiveData?: string;
};
export declare function parseSlackModalPrivateMetadata(raw: unknown): SlackModalPrivateMetadata;
export declare function encodeSlackModalPrivateMetadata(input: SlackModalPrivateMetadata): string;
export {};
