import type { ChannelPairingAdapter } from "./types.adapters.js";
type PairingNotifyParams = Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0];
export declare function createPairingPrefixStripper(prefixRe: RegExp, map?: (entry: string) => string): NonNullable<ChannelPairingAdapter["normalizeAllowEntry"]>;
export declare function createLoggedPairingApprovalNotifier(format: string | ((params: PairingNotifyParams) => string), log?: (message: string) => void): NonNullable<ChannelPairingAdapter["notifyApproval"]>;
export declare function createTextPairingAdapter(params: {
    idLabel: string;
    message: string;
    normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
    notify: (params: PairingNotifyParams & {
        message: string;
    }) => Promise<void> | void;
}): ChannelPairingAdapter;
export {};
