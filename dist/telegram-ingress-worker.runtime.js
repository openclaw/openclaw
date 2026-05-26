import { r as makeProxyFetch } from "./proxy-fetch-B02LTFkt.js";
import { t as resolveTelegramAllowedUpdates } from "./allowed-updates-C8V4-A3j.js";
import { o as normalizeTelegramApiRoot, r as resolveTelegramTransport } from "./fetch-Dy1LisTE.js";
import { a as isRecoverableTelegramNetworkError, n as resolveTelegramLongPollTimeoutSeconds, t as TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS } from "./request-timeouts-CnvnuqEE.js";
import { u as writeTelegramSpooledUpdate } from "./telegram-ingress-spool-mviSjVIC.js";
import { parentPort, workerData } from "node:worker_threads";
//#region extensions/telegram/src/telegram-ingress-worker.runtime.ts
const options = workerData;
const pollLimit = 100;
const retryInitialMs = 1e3;
const retryMaxMs = 3e4;
let stopped = false;
let activeController;
function post(message) {
	parentPort?.postMessage(message);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatErrorMessage(err) {
	if (err instanceof Error) return err.message || err.name;
	return String(err);
}
function resolveBackoff(attempt) {
	return Math.min(retryMaxMs, retryInitialMs * 2 ** Math.max(0, attempt - 1));
}
parentPort?.on("message", (message) => {
	if (message?.type !== "stop") return;
	stopped = true;
	activeController?.abort(/* @__PURE__ */ new Error("telegram ingress worker stopped"));
});
async function fetchJson(params) {
	const controller = new AbortController();
	activeController = controller;
	const timeout = setTimeout(() => {
		controller.abort(/* @__PURE__ */ new Error("Telegram getUpdates timed out"));
	}, TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const response = await params.fetch(params.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params.body),
			signal: controller.signal
		});
		const json = await response.json();
		if (!response.ok || json.ok !== true) throw new Error(typeof json.description === "string" ? json.description : `Telegram getUpdates failed with HTTP ${response.status}`);
		return json.result;
	} finally {
		clearTimeout(timeout);
		if (activeController === controller) activeController = void 0;
	}
}
async function main() {
	const transport = resolveTelegramTransport(options.proxy ? makeProxyFetch(options.proxy) : void 0, { network: options.network });
	const fetchImpl = transport.fetch ?? globalThis.fetch;
	const getUpdatesUrl = `${normalizeTelegramApiRoot(options.apiRoot ?? "https://api.telegram.org")}/bot${options.token}/getUpdates`;
	const pollTimeoutSeconds = resolveTelegramLongPollTimeoutSeconds(options.timeoutSeconds);
	let lastUpdateId = options.initialUpdateId;
	let failures = 0;
	try {
		for (;;) {
			if (stopped) break;
			const offset = lastUpdateId === null ? null : lastUpdateId + 1;
			post({
				type: "poll-start",
				offset,
				startedAt: Date.now()
			});
			try {
				const result = await fetchJson({
					fetch: fetchImpl,
					url: getUpdatesUrl,
					body: {
						timeout: pollTimeoutSeconds,
						limit: pollLimit,
						allowed_updates: resolveTelegramAllowedUpdates(),
						...offset === null ? {} : { offset }
					}
				});
				if (!Array.isArray(result)) throw new Error("Telegram getUpdates returned a non-array result.");
				for (const update of result) {
					if (stopped) break;
					const updateId = await writeTelegramSpooledUpdate({
						spoolDir: options.spoolDir,
						update
					});
					if (lastUpdateId === null || updateId > lastUpdateId) lastUpdateId = updateId;
					post({
						type: "spooled",
						updateId,
						queued: result.length
					});
				}
				failures = 0;
				post({
					type: "poll-success",
					offset,
					count: result.length,
					finishedAt: Date.now()
				});
			} catch (err) {
				if (stopped) break;
				failures += 1;
				post({
					type: "poll-error",
					message: formatErrorMessage(err),
					finishedAt: Date.now()
				});
				if (!isRecoverableTelegramNetworkError(err, { context: "polling" })) throw err;
				await sleep(resolveBackoff(failures));
			}
		}
	} finally {
		await transport.close();
	}
}
main().then(() => {
	parentPort?.close();
}).catch((err) => {
	post({
		type: "poll-error",
		message: formatErrorMessage(err),
		finishedAt: Date.now()
	});
	parentPort?.close();
	process.exitCode = stopped ? 0 : 1;
});
//#endregion
export {};
