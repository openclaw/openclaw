import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";
export declare function hasConfiguredCommandOwners(cfg: OpenClawConfig): boolean;
export declare function formatCommandOwnerFromChannelSender(params: {
    channel: PairingChannel;
    id: string;
}): string | null;
export declare function noteCommandOwnerHealth(cfg: OpenClawConfig): void;
