import "./read-only-account-inspect-DY5drRrW.js";
//#region src/channels/plugins/directory-adapters.ts
const nullChannelDirectorySelf = async () => null;
const emptyChannelDirectoryList = async () => [];
/** Build a channel directory adapter with a null self resolver by default. */
function createChannelDirectoryAdapter(params = {}) {
	return {
		self: params.self ?? nullChannelDirectorySelf,
		...params
	};
}
/** Build the common empty directory surface for channels without directory support. */
function createEmptyChannelDirectoryAdapter() {
	return createChannelDirectoryAdapter({
		listPeers: emptyChannelDirectoryList,
		listGroups: emptyChannelDirectoryList
	});
}
//#endregion
export { nullChannelDirectorySelf as i, createEmptyChannelDirectoryAdapter as n, emptyChannelDirectoryList as r, createChannelDirectoryAdapter as t };
