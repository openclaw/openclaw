import { t as movePathToTrash$1 } from "./trash-MLFC2x8b.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-CWznU0wp.js";
import "./temp-path-D1jrczoF.js";
import "./browser-config-Cfpt3nCT.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
