import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as isYes, t as isVerbose } from "./global-state-BAD7XgmL.js";
import "./globals-YU5FjfZK.js";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
//#region src/cli/prompt.ts
var PromptInputClosedError = class extends Error {
	constructor() {
		super("Prompt input closed before an answer was received.");
		this.name = "PromptInputClosedError";
	}
};
function questionUntilClose(rl, question) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (complete) => {
			if (settled) return;
			settled = true;
			rl.off("close", onClose);
			complete();
		};
		const onClose = () => finish(() => reject(new PromptInputClosedError()));
		rl.once("close", onClose);
		rl.question(question).then((answer) => finish(() => resolve(answer)), (error) => finish(() => reject(error)));
	});
}
async function promptYesNo(question, defaultYes = false) {
	if (isVerbose() && isYes()) return true;
	if (isYes()) return true;
	const rl = readline.createInterface({
		input: stdin,
		output: stdout
	});
	const answer = normalizeLowercaseStringOrEmpty(await questionUntilClose(rl, `${question}${defaultYes ? " [Y/n] " : " [y/N] "}`).finally(() => {
		rl.close();
	}));
	if (!answer) return defaultYes;
	return answer.startsWith("y");
}
//#endregion
export { promptYesNo as n, PromptInputClosedError as t };
