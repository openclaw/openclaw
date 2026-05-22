import { i as formatErrorMessage } from "./errors-D0hgXIu9.js";
import { d as withTimeout } from "./fs-safe-Cew-WMeL.js";
import "./text-runtime-CEUy8PW0.js";
import "./error-runtime-RR9SPa4x.js";
import { r as createSlackWebClient } from "./client-Ci_IqxFr.js";
//#region extensions/slack/src/probe.ts
async function probeSlack(token, timeoutMs = 2500) {
	const client = createSlackWebClient(token);
	const start = Date.now();
	try {
		const result = await withTimeout(client.auth.test(), timeoutMs);
		if (!result.ok) return {
			ok: false,
			status: 200,
			error: result.error ?? "unknown",
			elapsedMs: Date.now() - start
		};
		return {
			ok: true,
			status: 200,
			elapsedMs: Date.now() - start,
			bot: {
				id: result.user_id,
				name: result.user
			},
			team: {
				id: result.team_id,
				name: result.team
			}
		};
	} catch (err) {
		const message = formatErrorMessage(err);
		return {
			ok: false,
			status: typeof err.status === "number" ? err.status : null,
			error: message,
			elapsedMs: Date.now() - start
		};
	}
}
//#endregion
export { probeSlack as t };
