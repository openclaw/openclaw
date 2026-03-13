import { type TopLevelComponents } from "@buape/carbon";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
export type CrossContextComponentsBuilder = (message: string) => TopLevelComponents[];
export type CrossContextComponentsFactory = (params: {
    originLabel: string;
    message: string;
    cfg: OpenClawConfig;
    accountId?: string | null;
}) => TopLevelComponents[];
export type ChannelMessageAdapter = {
    supportsComponentsV2: boolean;
    buildCrossContextComponents?: CrossContextComponentsFactory;
};
export declare function getChannelMessageAdapter(channel: ChannelId): ChannelMessageAdapter;
