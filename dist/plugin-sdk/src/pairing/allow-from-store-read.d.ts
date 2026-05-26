import type { PairingChannel } from "./pairing-store.types.js";
export declare function resolveChannelAllowFromPath(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string;
export declare function readChannelAllowFromStoreEntriesSync(channel: PairingChannel, env?: NodeJS.ProcessEnv, accountId?: string): string[];
export declare function clearAllowFromStoreReadCacheForTest(): void;
