import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DItE5Xhf.js";
import "./temp-path-Cv3EKWOY.js";
import { t as movePathToTrash$1 } from "./browser-trash-CsYkd0p3.js";
import "./browser-config-DC2Gs7yA.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
