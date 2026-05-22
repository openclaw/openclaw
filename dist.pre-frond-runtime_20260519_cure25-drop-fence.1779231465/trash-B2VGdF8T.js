import { t as movePathToTrash$1 } from "./trash-DKFoImKb.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DcfgoqmC.js";
import "./temp-path-wFoXjiF4.js";
import "./browser-config-DIOZ7S0z.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
