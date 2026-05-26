import { c as normalizeOptionalString, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { l as redactToolPayloadText } from "./redact-ok5Q8nmw.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as asNullableRecord } from "./record-coerce-aMlBWINm.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { C as BrowserTabNotFoundError, b as BrowserProfileUnavailableError, f as redactCdpUrl } from "./cdp.helpers-D-78hr0t.js";
import "./tmp-openclaw-dir-3NYlGVmB.js";
import "./record-shared-D84z0tk0.js";
import "./subsystem-CZs4Zera.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
//#region extensions/browser/src/browser/chrome-mcp.ts
const log = createSubsystemLogger("browser").child("chrome-mcp");
const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_PACKAGE_ARGS = ["-y", "chrome-devtools-mcp@latest"];
const DEFAULT_CHROME_MCP_FEATURE_ARGS = ["--experimentalStructuredContent", "--experimental-page-id-routing"];
const CHROME_MCP_CONNECTION_FLAGS = new Set([
	"--autoConnect",
	"--auto-connect",
	"--browserUrl",
	"--browser-url",
	"--wsEndpoint",
	"--ws-endpoint",
	"-w"
]);
const CHROME_MCP_USER_DATA_DIR_FLAGS = new Set(["--userDataDir", "--user-data-dir"]);
const CHROME_MCP_NEW_PAGE_TIMEOUT_MS = 5e3;
const CHROME_MCP_NAVIGATE_TIMEOUT_MS = 2e4;
const CHROME_MCP_HANDSHAKE_TIMEOUT_MS = 3e4;
const CHROME_MCP_STDERR_MAX_BYTES = 8 * 1024;
const CDP_URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
const STALE_SELECTED_PAGE_ERROR = "The selected page has been closed. Call list_pages to see open pages.";
const sessions = /* @__PURE__ */ new Map();
const pendingSessions = /* @__PURE__ */ new Map();
let sessionFactory = null;
function asPages(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) {
		const record = asNullableRecord(entry);
		if (!record || typeof record.id !== "number") continue;
		out.push({
			id: record.id,
			url: readStringValue(record.url),
			selected: record.selected === true
		});
	}
	return out;
}
function parsePageId(targetId) {
	const parsed = Number.parseInt(targetId.trim(), 10);
	if (!Number.isFinite(parsed)) throw new BrowserTabNotFoundError();
	return parsed;
}
function toBrowserTabs(pages) {
	return pages.map((page) => ({
		targetId: String(page.id),
		title: "",
		url: page.url ?? "",
		type: "page"
	}));
}
function extractStructuredContent(result) {
	return asNullableRecord(result.structuredContent) ?? {};
}
function extractTextContent(result) {
	return (Array.isArray(result.content) ? result.content : []).map((entry) => {
		const record = asNullableRecord(entry);
		return record && typeof record.text === "string" ? record.text : "";
	}).filter(Boolean);
}
function extractTextPages(result) {
	const pages = [];
	for (const block of extractTextContent(result)) for (const line of block.split(/\r?\n/)) {
		const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
		if (!match) continue;
		pages.push({
			id: Number.parseInt(match[1] ?? "", 10),
			url: normalizeOptionalString(match[2]),
			selected: Boolean(match[3])
		});
	}
	return pages;
}
function extractStructuredPages(result) {
	const structured = asPages(extractStructuredContent(result).pages);
	return structured.length > 0 ? structured : extractTextPages(result);
}
function extractSnapshot(result) {
	const snapshot = asNullableRecord(extractStructuredContent(result).snapshot);
	if (!snapshot) throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
	return snapshot;
}
function extractJsonBlock(text) {
	const raw = text.match(/```json\s*([\s\S]*?)\s*```/i)?.[1]?.trim() || text.trim();
	return raw ? JSON.parse(raw) : null;
}
function extractMessageText(result) {
	const message = extractStructuredContent(result).message;
	if (typeof message === "string" && message.trim()) return message;
	return extractTextContent(result).find((block) => block.trim()) ?? "";
}
function extractToolErrorMessage(result, name) {
	return extractMessageText(result).trim() || `Chrome MCP tool "${name}" failed.`;
}
function shouldReconnectForToolError(name, message) {
	return name === "list_pages" && message.includes(STALE_SELECTED_PAGE_ERROR);
}
function extractJsonMessage(result) {
	const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) => text.trim());
	let lastError;
	for (const candidate of candidates) try {
		return extractJsonBlock(candidate);
	} catch (err) {
		lastError = err;
	}
	if (lastError) throw lastError;
	return null;
}
function normalizeChromeMcpUserDataDir(userDataDir) {
	const trimmed = userDataDir?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeChromeMcpStringList(values) {
	return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.trim().length > 0) : [];
}
function normalizeChromeMcpOptions(input) {
	if (typeof input === "object" && input && "command" in input && "extraArgs" in input) return input;
	const options = typeof input === "string" ? { userDataDir: input } : input ?? {};
	return {
		command: normalizeOptionalString(options.mcpCommand) ?? DEFAULT_CHROME_MCP_COMMAND,
		userDataDir: normalizeChromeMcpUserDataDir(options.userDataDir),
		browserUrl: normalizeOptionalString(options.cdpUrl),
		extraArgs: normalizeChromeMcpStringList(options.mcpArgs)
	};
}
function hasFlag(args, flags) {
	return args.some((arg) => {
		const [name] = arg.split("=", 1);
		return flags.has(name ?? arg);
	});
}
function isChromeMcpWebSocketEndpoint(url) {
	return /^wss?:\/\//i.test(url);
}
function buildChromeMcpConnectionArgs(options) {
	if (hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) return [];
	if (options.browserUrl) return isChromeMcpWebSocketEndpoint(options.browserUrl) ? ["--wsEndpoint", options.browserUrl] : ["--browserUrl", options.browserUrl];
	return ["--autoConnect"];
}
function buildChromeMcpUserDataDirArgs(options) {
	if (!options.userDataDir || options.browserUrl || hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS) || hasFlag(options.extraArgs, CHROME_MCP_USER_DATA_DIR_FLAGS)) return [];
	return ["--userDataDir", options.userDataDir];
}
function buildChromeMcpSessionCacheKey(profileName, options) {
	return JSON.stringify([
		profileName,
		options.userDataDir ?? "",
		options.browserUrl ?? "",
		options.command,
		options.extraArgs
	]);
}
function chromeMcpProfileOptionsFromParams(params) {
	return params.profile ?? params.userDataDir;
}
function cacheKeyMatchesProfileName(cacheKey, profileName) {
	try {
		const parsed = JSON.parse(cacheKey);
		return Array.isArray(parsed) && parsed[0] === profileName;
	} catch {
		return false;
	}
}
async function closeChromeMcpSessionsForProfile(profileName, keepKey) {
	let closed = false;
	for (const key of Array.from(pendingSessions.keys())) if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
		pendingSessions.delete(key);
		closed = true;
	}
	for (const [key, session] of Array.from(sessions.entries())) if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
		sessions.delete(key);
		closed = true;
		await session.client.close().catch(() => {});
	}
	return closed;
}
function buildChromeMcpArgsFromOptions(options) {
	return [
		...options.command === DEFAULT_CHROME_MCP_COMMAND ? DEFAULT_CHROME_MCP_PACKAGE_ARGS : [],
		...buildChromeMcpConnectionArgs(options),
		...DEFAULT_CHROME_MCP_FEATURE_ARGS,
		...buildChromeMcpUserDataDirArgs(options),
		...options.extraArgs
	];
}
function buildChromeMcpArgs(input) {
	return buildChromeMcpArgsFromOptions(normalizeChromeMcpOptions(input));
}
function drainStderr(transport) {
	const stream = transport.stderr;
	if (!stream) return () => "";
	const chunks = [];
	let totalBytes = 0;
	stream.on("data", (chunk) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const capped = buffer.length > CHROME_MCP_STDERR_MAX_BYTES ? buffer.subarray(buffer.length - CHROME_MCP_STDERR_MAX_BYTES) : buffer;
		chunks.push(capped);
		totalBytes += capped.length;
		while (totalBytes > CHROME_MCP_STDERR_MAX_BYTES && chunks.length > 1) {
			const dropped = chunks.shift();
			if (dropped) totalBytes -= dropped.length;
		}
	});
	stream.on("error", () => {});
	return () => Buffer.concat(chunks).toString("utf8").trim().slice(-8192);
}
function redactChromeMcpDiagnosticText(text) {
	return redactToolPayloadText(text.replace(CDP_URL_IN_TEXT_RE, (match) => redactToolPayloadText(redactCdpUrl(match) ?? match)));
}
function redactChromeMcpDiagnosticTextWithLocalPaths(text) {
	const homeDir = normalizeOptionalString(os.homedir());
	const homePath = homeDir ? path.resolve(homeDir) : void 0;
	return redactChromeMcpDiagnosticText(homePath ? text.split(homePath).join("~") : text);
}
function redactChromeMcpLocalPathForDiagnostic(filePath) {
	const homeDir = normalizeOptionalString(os.homedir());
	if (!homeDir || !path.isAbsolute(filePath)) return redactChromeMcpDiagnosticText(filePath);
	const relative = path.relative(path.resolve(homeDir), path.resolve(filePath));
	if (relative === "") return "~";
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) return redactChromeMcpDiagnosticText(`~/${relative.split(path.sep).join("/")}`);
	return redactChromeMcpDiagnosticText(filePath);
}
function redactChromeMcpProfileLabelForDiagnostic(profileName) {
	return path.isAbsolute(profileName) ? redactChromeMcpLocalPathForDiagnostic(profileName) : redactChromeMcpDiagnosticText(profileName);
}
async function withChromeMcpHandshakeTimeout(task) {
	let timer;
	try {
		return await Promise.race([task, new Promise((_, reject) => {
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("Chrome MCP handshake timed out")), CHROME_MCP_HANDSHAKE_TIMEOUT_MS);
			timer.unref?.();
		})]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function createRealSession(profileName, options = normalizeChromeMcpOptions()) {
	const transport = new StdioClientTransport({
		command: options.command,
		args: buildChromeMcpArgsFromOptions(options),
		stderr: "pipe"
	});
	const client = new Client({
		name: "openclaw-browser",
		version: "0.0.0"
	}, {});
	let getStderr = () => "";
	const ready = (async () => {
		try {
			await withChromeMcpHandshakeTimeout((async () => {
				await client.connect(transport);
				getStderr = drainStderr(transport);
				if (!(await client.listTools()).tools.some((tool) => tool.name === "list_pages")) throw new Error("Chrome MCP server did not expose the expected navigation tools.");
			})());
		} catch (err) {
			await client.close().catch(() => {});
			const stderr = getStderr();
			if (stderr) log.warn(`Chrome MCP attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". Subprocess stderr:\n${redactChromeMcpDiagnosticTextWithLocalPaths(stderr)}`);
			const targetLabel = options.browserUrl ? `the configured Chrome endpoint (${redactToolPayloadText(redactCdpUrl(options.browserUrl) ?? options.browserUrl)})` : options.userDataDir ? `the configured Chromium user data dir (${redactChromeMcpLocalPathForDiagnostic(options.userDataDir)})` : "Google Chrome's default profile";
			const detail = redactChromeMcpDiagnosticTextWithLocalPaths(err instanceof Error ? err.message : String(err));
			throw new BrowserProfileUnavailableError(`Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". Make sure ${targetLabel} is running locally with remote debugging enabled. Details: ${detail}`);
		}
	})();
	ready.catch(() => {});
	return {
		client,
		transport,
		ready
	};
}
async function waitForChromeMcpReady(session, profileName, timeoutMs, signal) {
	if (signal?.aborted) throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
	if ((!timeoutMs || timeoutMs <= 0) && !signal) {
		await session.ready;
		return;
	}
	let timer;
	let abortListener;
	try {
		const racers = [session.ready];
		if (timeoutMs && timeoutMs > 0) racers.push(new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new BrowserProfileUnavailableError(`Chrome MCP existing-session attach for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}" timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
		}));
		if (signal) racers.push(new Promise((_, reject) => {
			abortListener = () => reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			signal.addEventListener("abort", abortListener, { once: true });
		}));
		await Promise.race(racers);
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
	}
}
async function waitForChromeMcpPendingSession(pending, signal) {
	if (signal?.aborted) throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
	if (!signal) return await pending;
	let abortListener;
	try {
		return await Promise.race([pending, new Promise((_, reject) => {
			abortListener = () => reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			signal.addEventListener("abort", abortListener, { once: true });
		})]);
	} finally {
		if (abortListener) signal.removeEventListener("abort", abortListener);
	}
}
async function createChromeMcpSession(profileName, options, signal) {
	const created = (sessionFactory ?? createRealSession)(profileName, options);
	try {
		const session = await waitForChromeMcpPendingSession(created, signal);
		if (signal?.aborted) {
			await session.client.close().catch(() => {});
			throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
		}
		return session;
	} catch (err) {
		if (signal?.aborted) created.then((session) => session.client.close()).catch(() => {});
		throw err;
	}
}
async function getSession(profileName, profileOptions, timeoutMs, signal) {
	const options = normalizeChromeMcpOptions(profileOptions);
	const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
	await closeChromeMcpSessionsForProfile(profileName, cacheKey);
	let session = sessions.get(cacheKey);
	if (session && session.transport.pid === null) {
		sessions.delete(cacheKey);
		session = void 0;
	}
	if (!session) {
		let pending = pendingSessions.get(cacheKey);
		if (!pending) {
			pending = (async () => {
				const created = await createChromeMcpSession(profileName, options, signal);
				if (pendingSessions.get(cacheKey) === pending) sessions.set(cacheKey, created);
				else await created.client.close().catch(() => {});
				return created;
			})();
			pendingSessions.set(cacheKey, pending);
		}
		try {
			session = await pending;
		} finally {
			if (pendingSessions.get(cacheKey) === pending) pendingSessions.delete(cacheKey);
		}
	}
	try {
		await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
		return session;
	} catch (err) {
		if (sessions.get(cacheKey)?.transport === session.transport) sessions.delete(cacheKey);
		throw err;
	}
}
async function getExistingSession(cacheKey, profileName, timeoutMs, signal) {
	let session = sessions.get(cacheKey);
	if (session && session.transport.pid === null) {
		sessions.delete(cacheKey);
		session = void 0;
	}
	if (session) try {
		await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
		return session;
	} catch (err) {
		if (sessions.get(cacheKey)?.transport === session.transport) sessions.delete(cacheKey);
		throw err;
	}
	const pending = pendingSessions.get(cacheKey);
	if (!pending) return null;
	session = await waitForChromeMcpPendingSession(pending, signal);
	try {
		await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
		return session;
	} catch (err) {
		if (sessions.get(cacheKey)?.transport === session.transport) sessions.delete(cacheKey);
		throw err;
	}
}
async function createEphemeralSession(profileName, profileOptions, timeoutMs, signal) {
	const session = await createChromeMcpSession(profileName, normalizeChromeMcpOptions(profileOptions), signal);
	try {
		await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
		return session;
	} catch (err) {
		await session.client.close().catch(() => {});
		throw err;
	}
}
async function leaseSession(profileName, profileOptions, options = {}) {
	const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
	const cacheKey = buildChromeMcpSessionCacheKey(profileName, normalizedProfileOptions);
	if (!options.ephemeral) return {
		session: await getSession(profileName, normalizedProfileOptions, options.timeoutMs, options.signal),
		cacheKey,
		temporary: false
	};
	const existingSession = await getExistingSession(cacheKey, profileName, options.timeoutMs, options.signal);
	if (existingSession) return {
		session: existingSession,
		cacheKey,
		temporary: false
	};
	return {
		session: await createEphemeralSession(profileName, normalizedProfileOptions, options.timeoutMs, options.signal),
		cacheKey,
		temporary: true
	};
}
async function callTool(profileName, profileOptions, name, args = {}, options = {}) {
	const timeoutMs = options.timeoutMs;
	const signal = options.signal;
	if (signal?.aborted) throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const lease = await leaseSession(profileName, profileOptions, options);
		const rawCall = lease.session.client.callTool({
			name,
			arguments: args
		});
		let timeoutHandle;
		let abortListener;
		const racers = [rawCall];
		if (timeoutMs !== void 0 && timeoutMs > 0) racers.push(new Promise((_, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`Chrome MCP "${name}" timed out after ${timeoutMs}ms. Session reset for reconnect.`));
			}, timeoutMs);
		}));
		if (signal) racers.push(new Promise((_, reject) => {
			abortListener = () => reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			signal.addEventListener("abort", abortListener, { once: true });
		}));
		let result;
		try {
			result = racers.length === 1 ? await rawCall : await Promise.race(racers);
		} catch (err) {
			rawCall.catch(() => {});
			if (!lease.temporary) {
				if (sessions.get(lease.cacheKey)?.transport === lease.session.transport) {
					sessions.delete(lease.cacheKey);
					await lease.session.client.close().catch(() => {});
				}
			}
			throw err;
		} finally {
			if (timeoutHandle !== void 0) clearTimeout(timeoutHandle);
			if (signal && abortListener) signal.removeEventListener("abort", abortListener);
			if (lease.temporary) await lease.session.client.close().catch(() => {});
		}
		if (result.isError) {
			const message = extractToolErrorMessage(result, name);
			if (shouldReconnectForToolError(name, message)) {
				if (!lease.temporary) {
					if (sessions.get(lease.cacheKey)?.transport === lease.session.transport) {
						sessions.delete(lease.cacheKey);
						await lease.session.client.close().catch(() => {});
					}
				}
				if (attempt === 0) continue;
			}
			throw new Error(message);
		}
		return result;
	}
	throw new Error(`Chrome MCP tool "${name}" failed after reconnect.`);
}
async function withTempFile(fn) {
	const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-chrome-mcp-"));
	const filePath = path.join(dir, randomUUID());
	try {
		return await fn(filePath);
	} finally {
		await fs.rm(dir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
async function findPageById(profileName, pageId, profileOptions) {
	const page = (await listChromeMcpPages(profileName, profileOptions)).find((entry) => entry.id === pageId);
	if (!page) throw new BrowserTabNotFoundError();
	return page;
}
async function ensureChromeMcpAvailable(profileName, profileOptions, options = {}) {
	const lease = await leaseSession(profileName, profileOptions, options);
	if (lease.temporary) await lease.session.client.close().catch(() => {});
}
function getChromeMcpPid(profileName) {
	for (const [key, session] of sessions.entries()) if (cacheKeyMatchesProfileName(key, profileName)) return session.transport.pid ?? null;
	return null;
}
async function closeChromeMcpSession(profileName) {
	return await closeChromeMcpSessionsForProfile(profileName);
}
async function stopAllChromeMcpSessions() {
	const names = [...new Set([...sessions.keys()].map((key) => JSON.parse(key)[0]))];
	for (const name of names) await closeChromeMcpSession(name).catch(() => {});
}
async function listChromeMcpPages(profileName, profileOptions, options = {}) {
	return extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
}
async function listChromeMcpTabs(profileName, profileOptions, options = {}) {
	return toBrowserTabs(await listChromeMcpPages(profileName, profileOptions, options));
}
async function openChromeMcpTab(profileName, url, profileOptions) {
	const targetUrl = url.trim() || "about:blank";
	const pages = extractStructuredPages(await callTool(profileName, profileOptions, "new_page", {
		url: "about:blank",
		timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS
	}));
	const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
	if (!chosen) throw new Error("Chrome MCP did not return the created page.");
	const targetId = String(chosen.id);
	return {
		targetId,
		title: "",
		url: targetUrl === "about:blank" ? chosen.url ?? targetUrl : (await navigateChromeMcpPage({
			profileName,
			profile: typeof profileOptions === "string" ? void 0 : profileOptions,
			userDataDir: typeof profileOptions === "string" ? profileOptions : void 0,
			targetId,
			url: targetUrl,
			timeoutMs: CHROME_MCP_NAVIGATE_TIMEOUT_MS
		})).url,
		type: "page"
	};
}
async function focusChromeMcpTab(profileName, targetId, profileOptions) {
	await callTool(profileName, profileOptions, "select_page", {
		pageId: parsePageId(targetId),
		bringToFront: true
	});
}
async function closeChromeMcpTab(profileName, targetId, profileOptions) {
	await callTool(profileName, profileOptions, "close_page", { pageId: parsePageId(targetId) });
}
async function navigateChromeMcpPage(params) {
	const resolvedTimeoutMs = params.timeoutMs ?? CHROME_MCP_NAVIGATE_TIMEOUT_MS;
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "navigate_page", {
		pageId: parsePageId(params.targetId),
		type: "url",
		url: params.url,
		timeout: resolvedTimeoutMs
	}, { timeoutMs: resolvedTimeoutMs + 5e3 });
	return { url: (await findPageById(params.profileName, parsePageId(params.targetId), chromeMcpProfileOptionsFromParams(params))).url ?? params.url };
}
async function takeChromeMcpSnapshot(params) {
	return extractSnapshot(await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "take_snapshot", { pageId: parsePageId(params.targetId) }));
}
async function takeChromeMcpScreenshot(params) {
	return await withTempFile(async (filePath) => {
		const format = params.format ?? "png";
		await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "take_screenshot", {
			pageId: parsePageId(params.targetId),
			filePath,
			format,
			...params.uid ? { uid: params.uid } : {},
			...params.fullPage ? { fullPage: true } : {}
		}, { timeoutMs: params.timeoutMs });
		return await fs.readFile(`${filePath}.${format}`);
	});
}
async function clickChromeMcpElement(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "click", {
		pageId: parsePageId(params.targetId),
		uid: params.uid,
		...params.doubleClick ? { dblClick: true } : {}
	}, {
		timeoutMs: params.timeoutMs,
		signal: params.signal
	});
}
async function clickChromeMcpCoords(params) {
	const button = params.button ?? "left";
	const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
	const pressedButtons = button === "middle" ? 4 : button === "right" ? 2 : 1;
	const x = JSON.stringify(params.x);
	const y = JSON.stringify(params.y);
	const delayMs = JSON.stringify(Math.max(0, Math.floor(params.delayMs ?? 0)));
	const doubleClick = params.doubleClick ? "true" : "false";
	await evaluateChromeMcpScript({
		profileName: params.profileName,
		profile: params.profile,
		userDataDir: params.userDataDir,
		targetId: params.targetId,
		fn: `async () => {
      const x = ${x};
      const y = ${y};
      const delayMs = ${delayMs};
      const doubleClick = ${doubleClick};
      const target = document.elementFromPoint(x, y) ?? document.body ?? document.documentElement ?? document;
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        button: ${buttonCode},
      };
      const pressedButtons = ${pressedButtons};
      const dispatch = (type, buttons, detail) => {
        target.dispatchEvent(new MouseEvent(type, { ...base, buttons, detail }));
      };
      dispatch("mousemove", 0, 0);
      dispatch("mousedown", pressedButtons, 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      dispatch("mouseup", 0, 1);
      dispatch("click", 0, 1);
      if (doubleClick) {
        dispatch("mousedown", pressedButtons, 2);
        dispatch("mouseup", 0, 2);
        dispatch("click", 0, 2);
        dispatch("dblclick", 0, 2);
      }
      return true;
    }`
	});
}
async function fillChromeMcpElement(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill", {
		pageId: parsePageId(params.targetId),
		uid: params.uid,
		value: params.value
	});
}
async function fillChromeMcpForm(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill_form", {
		pageId: parsePageId(params.targetId),
		elements: params.elements
	});
}
async function hoverChromeMcpElement(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "hover", {
		pageId: parsePageId(params.targetId),
		uid: params.uid
	});
}
async function dragChromeMcpElement(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "drag", {
		pageId: parsePageId(params.targetId),
		from_uid: params.fromUid,
		to_uid: params.toUid
	});
}
async function uploadChromeMcpFile(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "upload_file", {
		pageId: parsePageId(params.targetId),
		uid: params.uid,
		filePath: params.filePath
	});
}
async function pressChromeMcpKey(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "press_key", {
		pageId: parsePageId(params.targetId),
		key: params.key
	});
}
async function resizeChromeMcpPage(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "resize_page", {
		pageId: parsePageId(params.targetId),
		width: params.width,
		height: params.height
	});
}
async function handleChromeMcpDialog(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "handle_dialog", {
		pageId: parsePageId(params.targetId),
		action: params.action,
		...params.promptText ? { promptText: params.promptText } : {}
	});
}
async function evaluateChromeMcpScript(params) {
	return extractJsonMessage(await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "evaluate_script", {
		pageId: parsePageId(params.targetId),
		function: params.fn,
		...params.args?.length ? { args: params.args } : {}
	}));
}
async function waitForChromeMcpText(params) {
	await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "wait_for", {
		pageId: parsePageId(params.targetId),
		text: params.text,
		...typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}
	});
}
function setChromeMcpSessionFactoryForTest(factory) {
	sessionFactory = factory;
}
async function resetChromeMcpSessionsForTest() {
	sessionFactory = null;
	pendingSessions.clear();
	await stopAllChromeMcpSessions();
}
//#endregion
export { stopAllChromeMcpSessions as C, waitForChromeMcpText as D, uploadChromeMcpFile as E, setChromeMcpSessionFactoryForTest as S, takeChromeMcpSnapshot as T, navigateChromeMcpPage as _, closeChromeMcpTab as a, resetChromeMcpSessionsForTest as b, evaluateChromeMcpScript as c, focusChromeMcpTab as d, getChromeMcpPid as f, listChromeMcpTabs as g, listChromeMcpPages as h, closeChromeMcpSession as i, fillChromeMcpElement as l, hoverChromeMcpElement as m, clickChromeMcpCoords as n, dragChromeMcpElement as o, handleChromeMcpDialog as p, clickChromeMcpElement as r, ensureChromeMcpAvailable as s, buildChromeMcpArgs as t, fillChromeMcpForm as u, openChromeMcpTab as v, takeChromeMcpScreenshot as w, resizeChromeMcpPage as x, pressChromeMcpKey as y };
