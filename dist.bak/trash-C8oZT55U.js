import { n as runExec } from "./exec-BhaMholX.js";
import { t as generateSecureToken } from "./secure-random-B3f7Ri2X.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

//#region src/browser/trash.ts
async function movePathToTrash(targetPath) {
	try {
		await runExec("trash", [targetPath], { timeoutMs: 1e4 });
		return targetPath;
	} catch {
		const trashDir = path.join(os.homedir(), ".Trash");
		fs.mkdirSync(trashDir, { recursive: true });
		const base = path.basename(targetPath);
		let dest = path.join(trashDir, `${base}-${Date.now()}`);
		if (fs.existsSync(dest)) dest = path.join(trashDir, `${base}-${Date.now()}-${generateSecureToken(6)}`);
		fs.renameSync(targetPath, dest);
		return dest;
	}
}

//#endregion
export { movePathToTrash as t };