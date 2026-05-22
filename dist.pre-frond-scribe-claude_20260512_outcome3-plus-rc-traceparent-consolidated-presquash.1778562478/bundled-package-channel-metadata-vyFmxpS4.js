import { t as listChannelCatalogEntries } from "./channel-catalog-registry-CNXtcf4Q.js";
//#region src/plugins/bundled-package-channel-metadata.ts
function listBundledPackageChannelMetadata() {
	return listChannelCatalogEntries({ origin: "bundled" }).map((entry) => entry.channel);
}
function findBundledPackageChannelMetadata(channelId) {
	return listBundledPackageChannelMetadata().find((channel) => channel.id === channelId || channel.aliases?.includes(channelId));
}
//#endregion
export { listBundledPackageChannelMetadata as n, findBundledPackageChannelMetadata as t };
