import "./env-Dhqok4CP.js";
import "./io-DoswVvYe.js";
import "./failover-matches-C-tab7FS.js";
import "./live-auth-keys-CV0sA4y1.js";
import "./png-encode-BeBwHWtd.js";
import { l as cleanupSessionStateForTest } from "./frozen-time-Cc9frCkh.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
//#region src/plugin-sdk/test-helpers/http-test-server.ts
async function withServer(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address) throw new Error("missing server address");
	try {
		await fn(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise((resolve) => server.close(() => resolve()));
	}
}
//#endregion
//#region src/plugin-sdk/test-helpers/mock-incoming-request.ts
function createMockIncomingRequest(chunks) {
	const req = new EventEmitter();
	req.destroyed = false;
	req.headers = {};
	req.destroy = () => {
		req.destroyed = true;
		return req;
	};
	Promise.resolve().then(() => {
		for (const chunk of chunks) {
			req.emit("data", Buffer.from(chunk, "utf-8"));
			if (req.destroyed) return;
		}
		req.emit("end");
	});
	return req;
}
//#endregion
//#region src/plugin-sdk/test-helpers/temp-home.ts
const SHARED_HOME_ROOTS = /* @__PURE__ */ new Map();
function snapshotEnv() {
	return {
		home: process.env.HOME,
		userProfile: process.env.USERPROFILE,
		homeDrive: process.env.HOMEDRIVE,
		homePath: process.env.HOMEPATH,
		openclawHome: process.env.OPENCLAW_HOME,
		stateDir: process.env.OPENCLAW_STATE_DIR
	};
}
function restoreEnv(snapshot) {
	const restoreKey = (key, value) => {
		if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	};
	restoreKey("HOME", snapshot.home);
	restoreKey("USERPROFILE", snapshot.userProfile);
	restoreKey("HOMEDRIVE", snapshot.homeDrive);
	restoreKey("HOMEPATH", snapshot.homePath);
	restoreKey("OPENCLAW_HOME", snapshot.openclawHome);
	restoreKey("OPENCLAW_STATE_DIR", snapshot.stateDir);
}
function snapshotExtraEnv(keys) {
	const snapshot = {};
	for (const key of keys) snapshot[key] = process.env[key];
	return snapshot;
}
function restoreExtraEnv(snapshot) {
	for (const [key, value] of Object.entries(snapshot)) if (value === void 0) delete process.env[key];
	else process.env[key] = value;
}
function setTempHome(base) {
	process.env.HOME = base;
	process.env.USERPROFILE = base;
	delete process.env.OPENCLAW_HOME;
	process.env.OPENCLAW_STATE_DIR = path.join(base, ".openclaw");
	if (process.platform !== "win32") return;
	const match = base.match(/^([A-Za-z]:)(.*)$/);
	if (!match) return;
	process.env.HOMEDRIVE = match[1];
	process.env.HOMEPATH = match[2] || "\\";
}
async function allocateTempHomeBase(prefix) {
	let state = SHARED_HOME_ROOTS.get(prefix);
	if (!state) {
		state = {
			rootPromise: fs.mkdtemp(path.join(os.tmpdir(), prefix)),
			nextCaseId: 0
		};
		SHARED_HOME_ROOTS.set(prefix, state);
	}
	const root = await state.rootPromise;
	const base = path.join(root, `case-${state.nextCaseId++}`);
	await fs.mkdir(base, { recursive: true });
	return base;
}
async function withTempHome(fn, opts = {}) {
	const base = await allocateTempHomeBase(opts.prefix ?? "openclaw-test-home-");
	const snapshot = snapshotEnv();
	const envKeys = Object.keys(opts.env ?? {});
	for (const key of envKeys) if (key === "HOME" || key === "USERPROFILE" || key === "HOMEDRIVE" || key === "HOMEPATH") throw new Error(`withTempHome: use built-in home env (got ${key})`);
	const envSnapshot = snapshotExtraEnv(envKeys);
	setTempHome(base);
	await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });
	if (opts.env) for (const [key, raw] of Object.entries(opts.env)) {
		const value = typeof raw === "function" ? raw(base) : raw;
		if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn(base);
	} finally {
		if (!opts.skipSessionCleanup) await cleanupSessionStateForTest().catch(() => void 0);
		restoreExtraEnv(envSnapshot);
		restoreEnv(snapshot);
		if (!opts.skipHomeCleanup) try {
			if (process.platform === "win32") await fs.rm(base, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50
			});
			else await fs.rm(base, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
//#endregion
export { createMockIncomingRequest as n, withServer as r, withTempHome as t };
