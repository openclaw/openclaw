import type { ChannelAccountPredicate, ChannelAccountSurface } from "./channel-secret-basic-runtime.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
export declare function collectNestedChannelTtsAssignments(params: {
    channelKey: string;
    nestedKey: string;
    channel: Record<string, unknown>;
    surface: ChannelAccountSurface;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    topLevelActive: boolean;
    topInactiveReason: string;
    accountActive: ChannelAccountPredicate;
    accountInactiveReason: string | ((entry: {
        accountId: string;
        account: Record<string, unknown>;
        enabled: boolean;
    }) => string);
}): void;
