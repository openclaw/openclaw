import { u as withTimeout } from "./fs-safe-DpJlqO1z.js";
import "./text-utility-runtime-CG5gZFsT.js";
import { r as createSlackWebClient } from "./client-BY5LT_WB.js";
import { t as formatSlackError } from "./errors-C7qatgFo.js";
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
		const message = formatSlackError(err);
		return {
			ok: false,
			status: typeof err.statusCode === "number" ? err.statusCode : null,
			error: message,
			elapsedMs: Date.now() - start
		};
	}
}
//#endregion
export { probeSlack as t };
