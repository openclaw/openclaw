import { t as createTokenjuiceOpenClawEmbeddedExtension } from "./runtime-api-Cw3HnOBh.js";
import process from "node:process";
//#region extensions/tokenjuice/tool-result-middleware.ts
function readCwd(event) {
	if (event.cwd?.trim()) return event.cwd;
	const workdir = event.args.workdir;
	if (typeof workdir === "string" && workdir.trim()) return workdir;
	return process.cwd();
}
function createTokenjuiceAgentToolResultMiddleware() {
	const handlers = [];
	createTokenjuiceOpenClawEmbeddedExtension()({ on(event, handler) {
		if (event === "tool_result") handlers.push(handler);
	} });
	return async (event) => {
		let current = event.result;
		for (const handler of handlers) {
			const next = await handler({
				toolName: event.toolName,
				input: event.args,
				content: current.content,
				details: current.details,
				isError: event.isError
			}, { cwd: readCwd(event) });
			if (next) current = Object.assign({}, current, {
				content: next.content ?? current.content,
				details: next.details ?? current.details
			});
		}
		return current === event.result ? void 0 : { result: current };
	};
}
//#endregion
export { createTokenjuiceAgentToolResultMiddleware as t };
