import "./fs-safe-defaults-DsMJI6H_.js";
import { n as fileStoreSync, t as fileStore } from "./file-store-BwssIVLK.js";
//#region src/infra/private-file-store.ts
function privateFileStore(rootDir) {
	return fileStore({
		rootDir,
		private: true
	});
}
function privateFileStoreSync(rootDir) {
	return fileStoreSync({
		rootDir,
		private: true
	});
}
//#endregion
export { privateFileStoreSync as n, privateFileStore as t };
