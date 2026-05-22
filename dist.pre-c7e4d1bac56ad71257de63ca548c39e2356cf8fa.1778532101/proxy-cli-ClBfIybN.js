import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
//#region src/cli/proxy-cli.ts
const proxyCliRuntimeLoader = createLazyImportLoader(() => import("./proxy-cli.runtime.js"));
async function loadProxyCliRuntime() {
	return await proxyCliRuntimeLoader.load();
}
function parseOptionalNumber(value) {
	if (!value) return;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function collectOption(value, previous) {
	return [...previous ?? [], value];
}
function registerProxyCli(program) {
	const proxy = program.command("proxy").description("Run the OpenClaw debug proxy and inspect captured traffic");
	proxy.command("start").description("Start the local explicit debug proxy").option("--host <host>", "Bind host", "127.0.0.1").option("--port <port>", "Bind port", parseOptionalNumber).action(async (opts) => {
		await (await loadProxyCliRuntime()).runDebugProxyStartCommand(opts);
	});
	proxy.command("run").description("Run a child command with OpenClaw debug proxy capture enabled").allowUnknownOption(true).allowExcessArguments(true).option("--host <host>", "Bind host", "127.0.0.1").option("--port <port>", "Bind port", parseOptionalNumber).argument("[cmd...]", "Command to run after --").action(async (cmd, opts) => {
		await (await loadProxyCliRuntime()).runDebugProxyRunCommand({
			host: opts.host,
			port: opts.port,
			commandArgs: cmd
		});
	});
	proxy.command("validate").description("Validate the operator-managed network proxy").option("--json", "Print machine-readable JSON").option("--proxy-url <url>", "Proxy URL to validate instead of config/env").option("--allowed-url <url>", "Destination expected to succeed through the proxy", collectOption).option("--denied-url <url>", "Destination expected to be blocked by the proxy", collectOption).option("--apns-reachable", "Also verify sandbox APNs HTTP/2 is reachable through the proxy").option("--apns-authority <url>", "APNs authority to probe with --apns-reachable").option("--timeout-ms <ms>", "Per-request timeout in milliseconds", parseOptionalNumber).action(async (opts) => {
		await (await loadProxyCliRuntime()).runProxyValidateCommand({
			json: opts.json,
			proxyUrl: opts.proxyUrl,
			allowedUrls: opts.allowedUrl,
			deniedUrls: opts.deniedUrl,
			apnsReachability: opts.apnsReachable,
			apnsAuthority: opts.apnsAuthority,
			timeoutMs: opts.timeoutMs
		});
	});
	proxy.command("coverage").description("Report current debug proxy transport coverage and remaining gaps").action(async () => {
		await (await loadProxyCliRuntime()).runDebugProxyCoverageCommand();
	});
	proxy.command("sessions").description("List recent capture sessions").option("--limit <count>", "Maximum sessions to show", parseOptionalNumber).action(async (opts) => {
		await (await loadProxyCliRuntime()).runDebugProxySessionsCommand(opts);
	});
	proxy.command("query").description("Run a built-in query preset against captured traffic").requiredOption("--preset <name>", "Query preset: double-sends, retry-storms, cache-busting, ws-duplicate-frames, missing-ack, error-bursts").option("--session <id>", "Restrict to a capture session id").action(async (opts) => {
		await (await loadProxyCliRuntime()).runDebugProxyQueryCommand({
			preset: opts.preset,
			sessionId: opts.session
		});
	});
	proxy.command("blob").description("Read a captured payload blob by id").requiredOption("--id <blobId>", "Blob id").action(async (opts) => {
		await (await loadProxyCliRuntime()).readDebugProxyBlobCommand({ blobId: opts.id });
	});
	proxy.command("purge").description("Delete all captured traffic metadata and blobs").action(async () => {
		await (await loadProxyCliRuntime()).runDebugProxyPurgeCommand();
	});
}
//#endregion
export { registerProxyCli };
