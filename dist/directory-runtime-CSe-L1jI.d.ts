import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { x as ChannelDirectoryAdapter } from "./types.adapters-y0dBEomF.js";
//#region src/channels/read-only-account-inspect.d.ts
type ReadOnlyInspectedAccount = Record<string, unknown>;
declare function inspectReadOnlyChannelAccount(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ReadOnlyInspectedAccount | null>;
//#endregion
//#region src/channels/plugins/directory-adapters.d.ts
declare const nullChannelDirectorySelf: NonNullable<ChannelDirectoryAdapter["self"]>;
declare const emptyChannelDirectoryList: NonNullable<ChannelDirectoryAdapter["listPeers"]>;
/** Build a channel directory adapter with a null self resolver by default. */
declare function createChannelDirectoryAdapter(params?: Omit<ChannelDirectoryAdapter, "self"> & {
  self?: ChannelDirectoryAdapter["self"];
}): ChannelDirectoryAdapter;
/** Build the common empty directory surface for channels without directory support. */
declare function createEmptyChannelDirectoryAdapter(): ChannelDirectoryAdapter;
//#endregion
export { ReadOnlyInspectedAccount as a, nullChannelDirectorySelf as i, createEmptyChannelDirectoryAdapter as n, inspectReadOnlyChannelAccount as o, emptyChannelDirectoryList as r, createChannelDirectoryAdapter as t };