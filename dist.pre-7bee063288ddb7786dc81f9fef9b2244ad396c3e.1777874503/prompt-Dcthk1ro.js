import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { b as isVerbose, x as isYes } from "./logger-BK1OY7lv.js";
import "./globals-C7I_COwU.js";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
//#region src/cli/prompt.ts
async function promptYesNo(question, defaultYes = false) {
	if (isVerbose() && isYes()) return true;
	if (isYes()) return true;
	const rl = readline.createInterface({
		input: stdin,
		output: stdout
	});
	const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
	const answer = normalizeLowercaseStringOrEmpty(await rl.question(`${question}${suffix}`));
	rl.close();
	if (!answer) return defaultYes;
	return answer.startsWith("y");
}
//#endregion
export { promptYesNo as t };
