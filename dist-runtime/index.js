#!/usr/bin/env node
import "./redact-CPjO5IzK.js";
import { i as formatUncaughtError } from "./errors-CHvVoeNX.js";
import { t as isMainModule } from "./is-main-DRn0Pf7d.js";
import { t as installUnhandledRejectionHandler } from "./unhandled-rejections-BUxLQs1F.js";
import process from "node:process";
import { fileURLToPath } from "node:url";
//#region src/index.ts
const library = await import("./library-CX670KV3.js");
const assertWebChannel = library.assertWebChannel;
const applyTemplate = library.applyTemplate;
const createDefaultDeps = library.createDefaultDeps;
const deriveSessionKey = library.deriveSessionKey;
const describePortOwner = library.describePortOwner;
const ensureBinary = library.ensureBinary;
const ensurePortAvailable = library.ensurePortAvailable;
const getReplyFromConfig = library.getReplyFromConfig;
const handlePortError = library.handlePortError;
const loadConfig = library.loadConfig;
const loadSessionStore = library.loadSessionStore;
const monitorWebChannel = library.monitorWebChannel;
const normalizeE164 = library.normalizeE164;
const PortInUseError = library.PortInUseError;
const promptYesNo = library.promptYesNo;
const resolveSessionKey = library.resolveSessionKey;
const resolveStorePath = library.resolveStorePath;
const runCommandWithTimeout = library.runCommandWithTimeout;
const runExec = library.runExec;
const saveSessionStore = library.saveSessionStore;
const toWhatsappJid = library.toWhatsappJid;
const waitForever = library.waitForever;
async function runLegacyCliEntry(argv = process.argv) {
	const [{ installGaxiosFetchCompat }, { runCli }] = await Promise.all([import("./gaxios-fetch-compat-DKeBlJsc.js"), import("./run-main-Bk1JfN3z.js")]);
	await installGaxiosFetchCompat();
	await runCli(argv);
}
if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
	installUnhandledRejectionHandler();
	process.on("uncaughtException", (error) => {
		console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
		process.exit(1);
	});
	runLegacyCliEntry(process.argv).catch((err) => {
		console.error("[openclaw] CLI failed:", formatUncaughtError(err));
		process.exit(1);
	});
}
//#endregion
export { PortInUseError, applyTemplate, assertWebChannel, createDefaultDeps, deriveSessionKey, describePortOwner, ensureBinary, ensurePortAvailable, getReplyFromConfig, handlePortError, loadConfig, loadSessionStore, monitorWebChannel, normalizeE164, promptYesNo, resolveSessionKey, resolveStorePath, runCommandWithTimeout, runExec, runLegacyCliEntry, saveSessionStore, toWhatsappJid, waitForever };
