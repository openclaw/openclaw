import "./fs-safe-defaults-PMwkNo6J.js";
import { n as fileStoreSync, t as fileStore } from "./file-store-BHMV3m_-.js";
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
