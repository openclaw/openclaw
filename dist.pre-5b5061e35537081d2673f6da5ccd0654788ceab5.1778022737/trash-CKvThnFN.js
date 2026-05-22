import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-24Sjadc6.js";
import "./temp-path-C-s8uU35.js";
import { t as movePathToTrash$1 } from "./browser-trash-QIkbW5Bp.js";
import "./browser-config-4WTKn1LY.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
