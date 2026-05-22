import { t as movePathToTrash$1 } from "./trash-CqyiO9vJ.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DJsd5QL4.js";
import "./temp-path-CwQ04ToL.js";
import "./browser-config-CBqAFMVW.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
