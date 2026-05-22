import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DItE5Xhf.js";
import "./temp-path-CUENfXMK.js";
import { t as movePathToTrash$1 } from "./browser-trash-5T4ZTGft.js";
import "./browser-config-BtkeI-ap.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
