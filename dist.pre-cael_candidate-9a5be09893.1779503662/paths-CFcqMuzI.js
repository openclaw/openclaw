import { n as saveJsonFile } from "./json-file-DpLhTVdZ.js";
import "./path-resolve-BcVdZbZe.js";
import "./constants-7n6RqnGG.js";
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
