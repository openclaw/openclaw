import { n as saveJsonFile } from "./json-file-DpLhTVdZ.js";
import "./path-resolve-C6Vj5eOM.js";
import "./constants-D_82oc2f.js";
import fs from "node:fs";
//#region src/agents/auth-profiles/paths.ts
function ensureAuthStoreFile(pathname) {
	if (fs.existsSync(pathname)) return;
	saveJsonFile(pathname, {
		version: 1,
		profiles: {}
	});
}
//#endregion
export { ensureAuthStoreFile as t };
