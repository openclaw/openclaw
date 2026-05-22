import { t as movePathToTrash$1 } from "./trash-DKFoImKb.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DJsd5QL4.js";
import "./temp-path-COGpsdv6.js";
import "./browser-config-BEHYRyV0.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
