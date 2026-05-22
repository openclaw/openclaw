import { t as movePathToTrash$1 } from "./trash-DKFoImKb.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DcfgoqmC.js";
import "./temp-path-CrCZNSPo.js";
import "./browser-config-iE6EBTnS.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
