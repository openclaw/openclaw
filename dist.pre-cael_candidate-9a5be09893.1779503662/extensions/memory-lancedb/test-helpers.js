import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-C60hWKdY.js";
import "../../temp-path-Dr0HtrH2.js";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach } from "vitest";
//#region extensions/memory-lancedb/test-helpers.ts
function installTmpDirHarness(params) {
	let tmpDir = "";
	let dbPath = "";
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), params.prefix));
		dbPath = path.join(tmpDir, "lancedb");
	});
	afterEach(async () => {
		if (tmpDir) await fs.rm(tmpDir, {
			recursive: true,
			force: true
		});
	});
	return {
		getTmpDir: () => tmpDir,
		getDbPath: () => dbPath
	};
}
//#endregion
export { installTmpDirHarness };
