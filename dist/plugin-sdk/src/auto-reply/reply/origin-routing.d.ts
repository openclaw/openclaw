import type { OriginatingChannelType } from "../templating.js";
export declare function resolveOriginMessageProvider(params: {
    originatingChannel?: OriginatingChannelType;
    provider?: string;
}): string | undefined;
export declare function resolveOriginMessageTo(params: {
    originatingTo?: string;
    to?: string;
}): string | undefined;
export declare function resolveOriginAccountId(params: {
    originatingAccountId?: string;
    accountId?: string;
}): string | undefined;
