import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C53Glfmy.js";
import "./temp-path-DITRKDIS.js";
import { t as movePathToTrash$1 } from "./browser-trash-BVzB0OFD.js";
import "./browser-config-Dxjmst1_.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
