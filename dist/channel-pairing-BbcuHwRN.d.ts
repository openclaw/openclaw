import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { t as ChannelPairingAdapter } from "./pairing.types-DRe9rMoD.js";
import { n as PluginRuntime } from "./types-DpjQFFwi.js";
import { m as issuePairingChallenge } from "./pairing-store-caRw7Va0.js";

//#region src/channels/plugins/pairing-adapters.d.ts
type PairingNotifyParams = Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0];
declare function createPairingPrefixStripper(prefixRe: RegExp, map?: (entry: string) => string): NonNullable<ChannelPairingAdapter["normalizeAllowEntry"]>;
declare function createLoggedPairingApprovalNotifier(format: string | ((params: PairingNotifyParams) => string), log?: (message: string) => void): NonNullable<ChannelPairingAdapter["notifyApproval"]>;
declare function createTextPairingAdapter(params: {
  idLabel: string;
  message: string;
  normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
  notify: (params: PairingNotifyParams & {
    message: string;
  }) => Promise<void> | void;
}): ChannelPairingAdapter;
//#endregion
//#region src/plugin-sdk/pairing-access.d.ts
type PairingApi = PluginRuntime["channel"]["pairing"];
type ScopedUpsertInput = Omit<Parameters<PairingApi["upsertPairingRequest"]>[0], "channel" | "accountId">;
/** Scope pairing store operations to one channel/account pair for plugin-facing helpers. */
declare function createScopedPairingAccess(params: {
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
//#endregion
//#region src/plugin-sdk/channel-pairing.d.ts
type ScopedPairingAccess = ReturnType<typeof createScopedPairingAccess>;
/** Pairing helpers scoped to one channel account. */
type ChannelPairingController = ScopedPairingAccess & {
  issueChallenge: (params: Omit<Parameters<typeof issuePairingChallenge>[0], "channel" | "upsertPairingRequest">) => ReturnType<typeof issuePairingChallenge>;
};
/** Pre-bind the channel id and storage sink for pairing challenges. */
declare function createChannelPairingChallengeIssuer(params: {
  channel: ChannelId;
  upsertPairingRequest: Parameters<typeof issuePairingChallenge>[0]["upsertPairingRequest"];
}): (challenge: Omit<Parameters<typeof issuePairingChallenge>[0], "channel" | "upsertPairingRequest">) => Promise<{
  created: boolean;
  code?: string;
}>;
/** Build the full scoped pairing controller used by channel runtime code. */
declare function createChannelPairingController(params: {
  core: PluginRuntime;
  channel: ChannelId;
  accountId: string;
}): ChannelPairingController;
//#endregion
export { createPairingPrefixStripper as a, createLoggedPairingApprovalNotifier as i, createChannelPairingChallengeIssuer as n, createTextPairingAdapter as o, createChannelPairingController as r, ChannelPairingController as t };