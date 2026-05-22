import type { Api, Context, Model } from "@earendil-works/pi-ai";
export declare function transformTransportMessages(messages: Context["messages"], model: Model<Api>, normalizeToolCallId?: (id: string, targetModel: Model<Api>, source: {
    provider: string;
    api: Api;
    model: string;
}) => string, options?: {
    normalizeSameModelToolCallIds?: boolean;
    preserveCrossModelToolCallThoughtSignature?: boolean;
}): Context["messages"];
