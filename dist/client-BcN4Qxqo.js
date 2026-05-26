import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./text-utility-runtime-CaGXarh9.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
//#region extensions/imessage/src/constants.ts
/** Default timeout for iMessage probe/RPC operations (10 seconds). */
const DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS = 1e4;
//#endregion
//#region extensions/imessage/src/client.ts
const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR = "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";
function isTestEnv() {
	const vitest = normalizeLowercaseStringOrEmpty(process.env.VITEST);
	return Boolean(vitest);
}
function normalizeIMessageFullDiskAccessError(message) {
	const normalized = normalizeLowercaseStringOrEmpty(message);
	if (!normalized.includes("full disk access") || !normalized.includes("chat.db")) return;
	return PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR;
}
var IMessageRpcClient = class {
	constructor(opts = {}) {
		this.pending = /* @__PURE__ */ new Map();
		this.closedResolve = null;
		this.child = null;
		this.reader = null;
		this.nextId = 1;
		this.publicProcessError = null;
		this.cliPath = opts.cliPath?.trim() || "imsg";
		this.dbPath = opts.dbPath?.trim() ? resolveUserPath(opts.dbPath) : void 0;
		this.runtime = opts.runtime;
		this.onNotification = opts.onNotification;
		this.closed = new Promise((resolve) => {
			this.closedResolve = resolve;
		});
	}
	async start() {
		if (this.child) return;
		if (isTestEnv()) throw new Error("Refusing to start imsg rpc in test environment; mock iMessage RPC client");
		const args = ["rpc"];
		if (this.dbPath) args.push("--db", this.dbPath);
		const child = spawn(this.cliPath, args, { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		this.child = child;
		this.reader = createInterface({ input: child.stdout });
		this.reader.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			this.handleLine(trimmed);
		});
		child.stderr?.on("data", (chunk) => {
			const lines = chunk.toString().split(/\r?\n/);
			for (const line of lines) {
				if (!line.trim()) continue;
				const trimmed = line.trim();
				this.recordProcessDiagnostic(trimmed);
				this.runtime?.error?.(`imsg rpc: ${trimmed}`);
			}
		});
		child.on("error", (err) => {
			this.failAll(err instanceof Error ? err : new Error(String(err)));
			this.closedResolve?.();
		});
		child.stdin.on("error", (err) => {
			this.failAll(err instanceof Error ? err : new Error(String(err)));
		});
		child.on("close", (code, signal) => {
			this.failAll(this.buildCloseError(code, signal));
			this.closedResolve?.();
		});
	}
	async stop() {
		if (!this.child) return;
		this.reader?.close();
		this.reader = null;
		this.child.stdin?.end();
		const child = this.child;
		this.child = null;
		await Promise.race([this.closed, new Promise((resolve) => {
			setTimeout(() => {
				if (!child.killed) child.kill("SIGTERM");
				resolve();
			}, 500);
		})]);
	}
	async waitForClose() {
		await this.closed;
	}
	async request(method, params, opts) {
		if (!this.child || !this.child.stdin) throw new Error("imsg rpc not running");
		const id = this.nextId++;
		const line = `${JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: params ?? {}
		})}\n`;
		const timeoutMs = opts?.timeoutMs ?? 1e4;
		const response = new Promise((resolve, reject) => {
			const key = String(id);
			const timer = timeoutMs > 0 ? setTimeout(() => {
				this.pending.delete(key);
				reject(/* @__PURE__ */ new Error(`imsg rpc timeout (${method})`));
			}, timeoutMs) : void 0;
			this.pending.set(key, {
				resolve: (value) => resolve(value),
				reject,
				timer
			});
		});
		this.child.stdin.write(line, (err) => {
			if (err) {
				const key = String(id);
				const pending = this.pending.get(key);
				if (pending) {
					if (pending.timer) clearTimeout(pending.timer);
					this.pending.delete(key);
					pending.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}
		});
		return await response;
	}
	handleLine(line) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			this.recordProcessDiagnostic(line);
			const detail = formatErrorMessage(err);
			this.runtime?.error?.(`imsg rpc: failed to parse ${line}: ${detail}`);
			return;
		}
		if (parsed.id !== void 0 && parsed.id !== null) {
			const key = String(parsed.id);
			const pending = this.pending.get(key);
			if (!pending) return;
			if (pending.timer) clearTimeout(pending.timer);
			this.pending.delete(key);
			if (parsed.error) {
				const baseMessage = parsed.error.message ?? "imsg rpc error";
				const details = parsed.error.data;
				const code = parsed.error.code;
				const suffixes = [];
				if (typeof code === "number") suffixes.push(`code=${code}`);
				if (details !== void 0) {
					const detailText = typeof details === "string" ? details : JSON.stringify(details, null, 2);
					if (detailText) suffixes.push(detailText);
				}
				const msg = suffixes.length > 0 ? `${baseMessage}: ${suffixes.join(" ")}` : baseMessage;
				pending.reject(new Error(msg));
				return;
			}
			pending.resolve(parsed.result);
			return;
		}
		if (parsed.method) this.onNotification?.({
			method: parsed.method,
			params: parsed.params
		});
	}
	recordProcessDiagnostic(line) {
		this.publicProcessError ??= normalizeIMessageFullDiskAccessError(line) ?? null;
	}
	buildCloseError(code, signal) {
		if (this.publicProcessError) return new Error(this.publicProcessError);
		if (code !== 0 && code !== null) {
			const reason = signal ? `signal ${signal}` : `code ${code}`;
			return /* @__PURE__ */ new Error(`imsg rpc exited (${reason})`);
		}
		return /* @__PURE__ */ new Error("imsg rpc closed");
	}
	failAll(err) {
		for (const [key, pending] of this.pending.entries()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(err);
			this.pending.delete(key);
		}
	}
};
async function createIMessageRpcClient(opts = {}) {
	const client = new IMessageRpcClient(opts);
	await client.start();
	return client;
}
//#endregion
export { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS as n, createIMessageRpcClient as t };
