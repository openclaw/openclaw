import type { PairingChannel } from "./pairing-store.js";
export declare function buildPairingReply(params: {
    channel: PairingChannel;
    idLine: string;
    code: string;
}): string;
