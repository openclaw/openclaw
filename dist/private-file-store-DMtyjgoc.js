import "./fs-safe-defaults-B7hUN42l.js";
import { n as fileStoreSync, t as fileStore } from "./file-store-BcfkC1se.js";
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
