import type { ChannelId } from "../channels/plugins/types.public.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
type PairingApi = PluginRuntime["channel"]["pairing"];
type ScopedUpsertInput = Omit<Parameters<PairingApi["upsertPairingRequest"]>[0], "channel" | "accountId">;
/** Scope pairing store operations to one channel/account pair for plugin-facing helpers. */
export declare function createScopedPairingAccess(params: {
    core: PluginRuntime;
    channel: ChannelId;
    accountId: string;
}): {
    accountId: string;
    readAllowFromStore: () => Promise<string[]>;
    readStoreForDmPolicy: (provider: ChannelId, accountId: string) => Promise<string[]>;
    upsertPairingRequest: (input: ScopedUpsertInput) => Promise<{
        code: string;
        created: boolean;
    }>;
};
export {};
