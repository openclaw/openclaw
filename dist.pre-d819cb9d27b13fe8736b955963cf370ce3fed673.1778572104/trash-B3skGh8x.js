import { t as movePathToTrash$1 } from "./trash-CqyiO9vJ.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-CWznU0wp.js";
import "./temp-path-D7ALviul.js";
import "./browser-config-B6-dE-Dc.js";
import os from "node:os";
//#region extensions/browser/src/browser/trash.ts
async function movePathToTrash(targetPath) {
	return await movePathToTrash$1(targetPath, { allowedRoots: [os.homedir(), resolvePreferredOpenClawTmpDir()] });
}
//#endregion
export { movePathToTrash as t };
