import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-D6cD8elg.js";
import "./temp-path-D5yZLChq.js";
import { t as movePathToTrash$1 } from "./browser-trash-V5pC7obm.js";
import "./browser-config-C-yKUQXV.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
