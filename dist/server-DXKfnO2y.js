import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, r as lowercasePreservingWhitespace } from "./string-coerce-LndEvhRk.js";
import { t as isTruthyEnvValue } from "./env-DL0trrAI.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { D as sanitizeUntrustedFileName } from "./fs-safe-DpJlqO1z.js";
import { o as root } from "./secure-temp-dir-GC3bO7Qi.js";
import { g as shortenHomePath, p as resolveUserPath, s as ensureDir } from "./utils-CKsuXgDI.js";
import { c as resolveEffectiveEnableState, s as normalizePluginsConfig } from "./config-state-BgyjpLHd.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C5ctwRKD.js";
import { a as asRecord } from "./record-coerce-CZkSQL9n.js";
import { n as detectMime } from "./mime-Bg_OIUJn.js";
import { t as resolveNodeFromNodeList } from "./node-resolve-BVBKQv8l.js";
import "./error-runtime-BnVeBNYa.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./state-paths-DTRyq4vN.js";
import "./runtime-B82zl-7p.js";
import { r as resolvePluginConfigObject } from "./plugin-config-runtime-DyMlx_D0.js";
import "./media-mime-C13b9Hj2.js";
import "./security-runtime-JcBeOGgV.js";
import "./gateway-runtime-6bU-ohwh.js";
import { n as callGatewayFromCli } from "./gateway-rpc-Dfnu29I8.js";
import { n as runCommandWithRuntime } from "./cli-utils-C7ZilvgD.js";
import "./cli-runtime-BuPrSAIi.js";
import "./text-utility-runtime-CG5gZFsT.js";
import { a as CANVAS_HOST_PATH, c as isA2uiPath, n as normalizeUrlPath, r as resolveFileWithinRoot, s as injectCanvasLiveReload } from "./a2ui-CObIXAm6.js";
import { createRequire } from "node:module";
import * as fsSync from "node:fs";
import fs from "node:fs";
import * as path$1 from "node:path";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import http from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import chokidar from "chokidar";
//#region extensions/canvas/src/a2ui-jsonl.ts
const A2UI_ACTION_KEYS = [
	"beginRendering",
	"surfaceUpdate",
	"dataModelUpdate",
	"deleteSurface",
	"createSurface"
];
function buildA2UITextJsonl(text) {
	const surfaceId = "main";
	const rootId = "root";
	const textId = "text";
	return [{ surfaceUpdate: {
		surfaceId,
		components: [{
			id: rootId,
			component: { Column: { children: { explicitList: [textId] } } }
		}, {
			id: textId,
			component: { Text: {
				text: { literalString: text },
				usageHint: "body"
			} }
		}]
	} }, { beginRendering: {
		surfaceId,
		root: rootId
	} }].map((payload) => JSON.stringify(payload)).join("\n");
}
function validateA2UIJsonl(jsonl) {
	const lines = jsonl.split(/\r?\n/);
	const errors = [];
	let sawV08 = false;
	let sawV09 = false;
	let messageCount = 0;
	lines.forEach((line, idx) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		messageCount += 1;
		let obj;
		try {
			obj = JSON.parse(trimmed);
		} catch (err) {
			errors.push(`line ${idx + 1}: ${String(err)}`);
			return;
		}
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
			errors.push(`line ${idx + 1}: expected JSON object`);
			return;
		}
		const record = obj;
		const actionKeys = A2UI_ACTION_KEYS.filter((key) => key in record);
		if (actionKeys.length !== 1) {
			errors.push(`line ${idx + 1}: expected exactly one action key (${A2UI_ACTION_KEYS.join(", ")})`);
			return;
		}
		if (actionKeys[0] === "createSurface") sawV09 = true;
		else sawV08 = true;
	});
	if (messageCount === 0) errors.push("no JSONL messages found");
	if (sawV08 && sawV09) errors.push("mixed A2UI v0.8 and v0.9 messages in one file");
	if (errors.length > 0) throw new Error(`Invalid A2UI JSONL:\n- ${errors.join("\n- ")}`);
	return {
		version: sawV09 ? "v0.9" : "v0.8",
		messageCount
	};
}
//#endregion
//#region extensions/canvas/src/cli-helpers.ts
function parseCanvasSnapshotPayload(value) {
	const obj = asRecord(value);
	const format = readStringValue(obj.format);
	const base64 = readStringValue(obj.base64);
	if (!format || !base64) throw new Error("invalid canvas.snapshot payload");
	return {
		format,
		base64
	};
}
function resolveCliName() {
	return "openclaw";
}
function resolveTempPathParts(opts) {
	const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
	if (!opts.tmpDir) fs.mkdirSync(tmpDir, {
		recursive: true,
		mode: 448
	});
	return {
		tmpDir,
		id: opts.id ?? randomUUID(),
		ext: opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`
	};
}
function canvasSnapshotTempPath(opts) {
	const { tmpDir, id, ext } = resolveTempPathParts(opts);
	const cliName = resolveCliName();
	return path$1.join(tmpDir, `${cliName}-canvas-snapshot-${id}${ext}`);
}
//#endregion
//#region extensions/canvas/src/cli.ts
function parseTimeoutMs(raw) {
	if (raw === void 0 || raw === null) return;
	const value = typeof raw === "number" || typeof raw === "bigint" ? Number(raw) : typeof raw === "string" && raw.trim() ? Number.parseInt(raw.trim(), 10) : NaN;
	return Number.isFinite(value) ? value : void 0;
}
function parseNodeCandidates(raw) {
	const payload = raw && typeof raw === "object" ? raw : {};
	return (Array.isArray(payload.nodes) ? payload.nodes : Array.isArray(payload.paired) ? payload.paired : []).map((entry) => {
		if (!entry || typeof entry !== "object") return null;
		const node = entry;
		if (typeof node.nodeId !== "string") return null;
		const candidate = { nodeId: node.nodeId };
		if (typeof node.displayName === "string") candidate.displayName = node.displayName;
		if (typeof node.remoteIp === "string") candidate.remoteIp = node.remoteIp;
		if (typeof node.connected === "boolean") candidate.connected = node.connected;
		if (typeof node.clientId === "string") candidate.clientId = node.clientId;
		return candidate;
	}).filter((entry) => entry !== null);
}
function unauthorizedHintForMessage(message) {
	const haystack = normalizeLowercaseStringOrEmpty(message);
	if (haystack.includes("unauthorizedclient") || haystack.includes("bridge client is not authorized") || haystack.includes("unsigned bridge clients are not allowed")) return [
		"peekaboo bridge rejected the client.",
		"sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
		"PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev."
	].join(" ");
	return null;
}
function createDefaultCanvasCliDependencies() {
	const nodesCallOpts = (cmd, defaults) => cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 1e4)).option("--json", "Output JSON", false);
	const callGatewayCli = async (method, opts, params, callOpts) => {
		const timeout = String(callOpts?.transportTimeoutMs ?? opts.timeout ?? 1e4);
		return await callGatewayFromCli(method, {
			...opts,
			timeout
		}, params, { progress: opts.json !== true });
	};
	return {
		defaultRuntime,
		nodesCallOpts,
		runNodesCommand: (label, action) => runCommandWithRuntime(defaultRuntime, action, (err) => {
			const message = formatErrorMessage(err);
			defaultRuntime.error(theme.error(`nodes ${label} failed: ${message}`));
			const hint = unauthorizedHintForMessage(message);
			if (hint) defaultRuntime.error(theme.warn(hint));
			defaultRuntime.exit(1);
		}),
		getNodesTheme: () => ({ ok: theme.success }),
		parseTimeoutMs,
		resolveNodeId: async (opts, query) => {
			let raw;
			try {
				raw = await callGatewayCli("node.list", opts, {});
			} catch {
				raw = await callGatewayCli("node.pair.list", opts, {});
			}
			return resolveNodeFromNodeList(parseNodeCandidates(raw), query).nodeId;
		},
		buildNodeInvokeParams: ({ nodeId, command, params, timeoutMs }) => ({
			nodeId,
			command,
			params,
			idempotencyKey: randomUUID(),
			...typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? { timeoutMs } : {}
		}),
		callGatewayCli,
		writeBase64ToFile: async (filePath, base64) => await fs$1.writeFile(filePath, Buffer.from(base64, "base64")),
		shortenHomePath
	};
}
async function invokeCanvas(deps, opts, command, params) {
	const nodeId = await deps.resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
	const timeoutMs = deps.parseTimeoutMs(opts.invokeTimeout);
	return await deps.callGatewayCli("node.invoke", opts, deps.buildNodeInvokeParams({
		nodeId,
		command,
		params,
		timeoutMs: typeof timeoutMs === "number" ? timeoutMs : void 0
	}));
}
function registerNodesCanvasCommands(nodes, deps) {
	const canvas = nodes.command("canvas").description("Capture or render canvas content from a paired node");
	deps.nodesCallOpts(canvas.command("snapshot").description("Capture a canvas snapshot (prints MEDIA:<path>)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--format <png|jpg|jpeg>", "Image format", "jpg").option("--max-width <px>", "Max width in px (optional)").option("--quality <0-1>", "JPEG quality (optional)").option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 20000)", "20000").action(async (opts) => {
		await deps.runNodesCommand("canvas snapshot", async () => {
			const formatOpt = normalizeLowercaseStringOrEmpty(normalizeOptionalString(opts.format) ?? "jpg");
			const formatForParams = formatOpt === "jpg" ? "jpeg" : formatOpt === "jpeg" ? "jpeg" : "png";
			if (formatForParams !== "png" && formatForParams !== "jpeg") throw new Error(`invalid format: ${String(opts.format)} (expected png|jpg|jpeg)`);
			const maxWidth = opts.maxWidth ? Number.parseInt(opts.maxWidth, 10) : void 0;
			const quality = opts.quality ? Number.parseFloat(opts.quality) : void 0;
			const raw = await invokeCanvas(deps, opts, "canvas.snapshot", {
				format: formatForParams,
				maxWidth: Number.isFinite(maxWidth) ? maxWidth : void 0,
				quality: Number.isFinite(quality) ? quality : void 0
			});
			const payload = parseCanvasSnapshotPayload((typeof raw === "object" && raw !== null ? raw : {}).payload);
			const filePath = canvasSnapshotTempPath({ ext: payload.format === "jpeg" ? "jpg" : payload.format });
			await deps.writeBase64ToFile(filePath, payload.base64);
			if (opts.json) {
				deps.defaultRuntime.writeJson({ file: {
					path: filePath,
					format: payload.format
				} });
				return;
			}
			deps.defaultRuntime.log(`MEDIA:${deps.shortenHomePath(filePath)}`);
		});
	}), { timeoutMs: 6e4 });
	deps.nodesCallOpts(canvas.command("present").description("Show the canvas (optionally with a target URL/path)").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--target <urlOrPath>", "Target URL/path (optional)").option("--x <px>", "Placement x coordinate").option("--y <px>", "Placement y coordinate").option("--width <px>", "Placement width").option("--height <px>", "Placement height").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas present", async () => {
			const placement = {
				x: opts.x ? Number.parseFloat(opts.x) : void 0,
				y: opts.y ? Number.parseFloat(opts.y) : void 0,
				width: opts.width ? Number.parseFloat(opts.width) : void 0,
				height: opts.height ? Number.parseFloat(opts.height) : void 0
			};
			const params = {};
			if (opts.target) params.url = opts.target;
			if (Number.isFinite(placement.x) || Number.isFinite(placement.y) || Number.isFinite(placement.width) || Number.isFinite(placement.height)) params.placement = placement;
			await invokeCanvas(deps, opts, "canvas.present", params);
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas present ok"));
			}
		});
	}));
	deps.nodesCallOpts(canvas.command("hide").description("Hide the canvas").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas hide", async () => {
			await invokeCanvas(deps, opts, "canvas.hide", void 0);
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas hide ok"));
			}
		});
	}));
	deps.nodesCallOpts(canvas.command("navigate").description("Navigate the canvas to a URL").argument("<url>", "Target URL/path").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (url, opts) => {
		await deps.runNodesCommand("canvas navigate", async () => {
			await invokeCanvas(deps, opts, "canvas.navigate", { url });
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas navigate ok"));
			}
		});
	}));
	deps.nodesCallOpts(canvas.command("eval").description("Evaluate JavaScript in the canvas").argument("[js]", "JavaScript to evaluate").option("--js <code>", "JavaScript to evaluate").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (jsArg, opts) => {
		await deps.runNodesCommand("canvas eval", async () => {
			const js = opts.js ?? jsArg;
			if (!js) throw new Error("missing --js or <js>");
			const raw = await invokeCanvas(deps, opts, "canvas.eval", { javaScript: js });
			if (opts.json) {
				deps.defaultRuntime.writeJson(raw);
				return;
			}
			const payload = typeof raw === "object" && raw !== null ? raw.payload : void 0;
			if (payload?.result) deps.defaultRuntime.log(payload.result);
			else {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas eval ok"));
			}
		});
	}));
	const a2ui = canvas.command("a2ui").description("Render A2UI content on the canvas");
	deps.nodesCallOpts(a2ui.command("push").description("Push A2UI JSONL to the canvas").option("--jsonl <path>", "Path to JSONL payload").option("--text <text>", "Render a quick A2UI text payload").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas a2ui push", async () => {
			const hasJsonl = Boolean(opts.jsonl);
			const hasText = typeof opts.text === "string";
			if (hasJsonl === hasText) throw new Error("provide exactly one of --jsonl or --text");
			const jsonl = hasText ? buildA2UITextJsonl(opts.text ?? "") : await fs$1.readFile(String(opts.jsonl), "utf8");
			const { version, messageCount } = validateA2UIJsonl(jsonl);
			if (version === "v0.9") throw new Error("Detected A2UI v0.9 JSONL (createSurface). OpenClaw currently supports v0.8 only.");
			await invokeCanvas(deps, opts, "canvas.a2ui.pushJSONL", { jsonl });
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok(`canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`));
			}
		});
	}));
	deps.nodesCallOpts(a2ui.command("reset").description("Reset A2UI renderer state").requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP").option("--invoke-timeout <ms>", "Node invoke timeout in ms").action(async (opts) => {
		await deps.runNodesCommand("canvas a2ui reset", async () => {
			await invokeCanvas(deps, opts, "canvas.a2ui.reset", void 0);
			if (!opts.json) {
				const { ok } = deps.getNodesTheme();
				deps.defaultRuntime.log(ok("canvas a2ui reset ok"));
			}
		});
	}));
}
//#endregion
//#region extensions/canvas/src/config.ts
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function readString(value) {
	return typeof value === "string" ? value : void 0;
}
function readPositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function parseCanvasHostConfig(value) {
	if (!isRecord(value)) return;
	return {
		...readBoolean(value.enabled) !== void 0 ? { enabled: readBoolean(value.enabled) } : {},
		...readString(value.root) !== void 0 ? { root: readString(value.root) } : {},
		...readPositiveInteger(value.port) !== void 0 ? { port: readPositiveInteger(value.port) } : {},
		...readBoolean(value.liveReload) !== void 0 ? { liveReload: readBoolean(value.liveReload) } : {}
	};
}
function parseCanvasPluginConfig(value) {
	if (!isRecord(value)) return {};
	const host = parseCanvasHostConfig(value.host);
	return host ? { host } : {};
}
function isCanvasPluginEnabled(config) {
	if (!config) return true;
	return resolveEffectiveEnableState({
		id: "canvas",
		origin: "bundled",
		config: normalizePluginsConfig(config.plugins),
		rootConfig: config,
		enabledByDefault: true
	}).enabled;
}
function resolveCanvasHostConfig(params) {
	return parseCanvasPluginConfig(params.pluginConfig ?? resolvePluginConfigObject(params.config, "canvas") ?? {}).host ?? {};
}
function isCanvasHostEnabled(config) {
	if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) return false;
	if (!isCanvasPluginEnabled(config)) return false;
	return resolveCanvasHostConfig({ config }).enabled !== false;
}
const canvasConfigSchema = {
	parse: parseCanvasPluginConfig,
	uiHints: {
		host: {
			label: "Canvas Host",
			help: "Serves local Canvas and A2UI files for paired nodes.",
			advanced: true
		},
		"host.enabled": {
			label: "Canvas Host Enabled",
			advanced: true
		},
		"host.root": {
			label: "Canvas Host Root Directory",
			help: "Directory to serve. Defaults to the OpenClaw state canvas directory.",
			advanced: true
		},
		"host.port": {
			label: "Canvas Host Port",
			advanced: true
		},
		"host.liveReload": {
			label: "Canvas Host Live Reload",
			advanced: true
		}
	}
};
//#endregion
//#region extensions/canvas/src/documents.ts
const CANVAS_DOCUMENTS_DIR_NAME = "documents";
function isPdfPathLike(value) {
	return /\.pdf(?:[?#].*)?$/i.test(value.trim());
}
function buildPdfWrapper(url) {
	const escaped = escapeHtml(url);
	return `<!doctype html><html><body style="margin:0;background:#e5e7eb;"><object data="${escaped}" type="application/pdf" style="width:100%;height:100vh;border:0;"><iframe src="${escaped}" style="width:100%;height:100vh;border:0;"></iframe><p style="padding:16px;font:14px system-ui,sans-serif;">Unable to render PDF preview. <a href="${escaped}" target="_blank" rel="noopener noreferrer">Open PDF</a>.</p></object></body></html>`;
}
function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
function normalizeLogicalPath(value) {
	const parts = value.replaceAll("\\", "/").replace(/^\/+/, "").split("/").filter(Boolean);
	if (parts.length === 0 || parts.some((part) => part === "." || part === ".." || part.includes(":") || hasControlCharacter(part))) throw new Error("canvas document logicalPath invalid");
	return parts.join("/");
}
function hasControlCharacter(value) {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}
function canvasDocumentId() {
	return `cv_${randomUUID().replaceAll("-", "")}`;
}
function normalizeCanvasDocumentId(value) {
	const normalized = value.trim();
	if (!normalized || normalized === "." || normalized === ".." || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error("canvas document id invalid");
	return normalized;
}
function resolveCanvasRootDir(rootDir, stateDir = resolveStateDir()) {
	const resolved = rootDir?.trim() ? resolveUserPath(rootDir) : path.join(stateDir, "canvas");
	return path.resolve(resolved);
}
function resolveCanvasDocumentsDir(rootDir, stateDir = resolveStateDir()) {
	return path.join(resolveCanvasRootDir(rootDir, stateDir), CANVAS_DOCUMENTS_DIR_NAME);
}
function resolveCanvasDocumentDir(documentId, options) {
	return path.join(resolveCanvasDocumentsDir(options?.rootDir, options?.stateDir), documentId);
}
function buildCanvasDocumentEntryUrl(documentId, entrypoint) {
	const encodedEntrypoint = normalizeLogicalPath(entrypoint).split("/").map((segment) => encodeURIComponent(segment)).join("/");
	return `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/${encodeURIComponent(documentId)}/${encodedEntrypoint}`;
}
function buildCanvasDocumentAssetUrl(documentId, logicalPath) {
	return buildCanvasDocumentEntryUrl(documentId, logicalPath);
}
function resolveCanvasHttpPathToLocalPath(requestPath, options) {
	const trimmed = requestPath.trim();
	const prefix = `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/`;
	if (!trimmed.startsWith(prefix)) return null;
	const segments = trimmed.replace(/[?#].*$/, "").slice(prefix.length).split("/").map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	}).filter(Boolean);
	if (segments.length < 2) return null;
	const [rawDocumentId, ...entrySegments] = segments;
	try {
		const documentId = normalizeCanvasDocumentId(rawDocumentId);
		const normalizedEntrypoint = normalizeLogicalPath(entrySegments.join("/"));
		const documentsDir = path.resolve(resolveCanvasDocumentsDir(options?.rootDir, options?.stateDir));
		const candidatePath = path.resolve(resolveCanvasDocumentDir(documentId, options), normalizedEntrypoint);
		if (!(candidatePath === documentsDir || candidatePath.startsWith(`${documentsDir}${path.sep}`))) return null;
		return candidatePath;
	} catch {
		return null;
	}
}
async function writeManifest(root, manifest) {
	await root.writeJson("manifest.json", manifest, { space: 2 });
}
async function copyAssets(root, assets, workspaceDir) {
	const copied = [];
	for (const asset of assets ?? []) {
		const logicalPath = normalizeLogicalPath(asset.logicalPath);
		const sourcePath = asset.sourcePath.startsWith("~") ? resolveUserPath(asset.sourcePath) : path.isAbsolute(asset.sourcePath) ? path.resolve(asset.sourcePath) : path.resolve(workspaceDir, asset.sourcePath);
		await root.copyIn(logicalPath, sourcePath);
		copied.push({
			logicalPath,
			...asset.contentType ? { contentType: asset.contentType } : {}
		});
	}
	return copied;
}
async function materializeEntrypoint(rootDir, root, input, workspaceDir) {
	const entrypoint = input.entrypoint;
	if (!entrypoint) throw new Error("canvas document entrypoint required");
	if (entrypoint.type === "html") {
		const fileName = "index.html";
		await root.write(fileName, entrypoint.value);
		return {
			localEntrypoint: fileName,
			entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName)
		};
	}
	if (entrypoint.type === "url") {
		if (input.kind === "document" && isPdfPathLike(entrypoint.value)) {
			const fileName = "index.html";
			await root.write(fileName, buildPdfWrapper(entrypoint.value));
			return {
				localEntrypoint: fileName,
				externalUrl: entrypoint.value,
				entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName)
			};
		}
		return {
			externalUrl: entrypoint.value,
			entryUrl: entrypoint.value
		};
	}
	const resolvedPath = entrypoint.value.startsWith("~") ? resolveUserPath(entrypoint.value) : path.isAbsolute(entrypoint.value) ? path.resolve(entrypoint.value) : path.resolve(workspaceDir, entrypoint.value);
	if (input.kind === "image" || input.kind === "video_asset") {
		const copiedName = sanitizeUntrustedFileName(path.basename(resolvedPath), "asset");
		await root.copyIn(copiedName, resolvedPath);
		const wrapper = input.kind === "image" ? `<!doctype html><html><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;"><img src="${escapeHtml(copiedName)}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body></html>` : `<!doctype html><html><body style="margin:0;background:#0f172a;"><video src="${escapeHtml(copiedName)}" controls autoplay style="width:100%;height:100vh;object-fit:contain;background:#000;"></video></body></html>`;
		await root.write("index.html", wrapper);
		return {
			localEntrypoint: "index.html",
			entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), "index.html")
		};
	}
	const fileName = sanitizeUntrustedFileName(path.basename(resolvedPath), "document");
	await root.copyIn(fileName, resolvedPath);
	if (input.kind === "document" && isPdfPathLike(fileName)) {
		await root.write("index.html", buildPdfWrapper(fileName));
		return {
			localEntrypoint: "index.html",
			entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), "index.html")
		};
	}
	return {
		localEntrypoint: fileName,
		entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName)
	};
}
async function createCanvasDocument(input, options) {
	const workspaceDir = options?.workspaceDir ?? process.cwd();
	const id = input.id?.trim() ? normalizeCanvasDocumentId(input.id) : canvasDocumentId();
	const rootDir = resolveCanvasDocumentDir(id, {
		stateDir: options?.stateDir,
		rootDir: options?.canvasRootDir
	});
	await fs$1.rm(rootDir, {
		recursive: true,
		force: true
	}).catch(() => void 0);
	await fs$1.mkdir(rootDir, { recursive: true });
	const root$1 = await root(rootDir);
	const assets = await copyAssets(root$1, input.assets, workspaceDir);
	const entry = await materializeEntrypoint(rootDir, root$1, input, workspaceDir);
	const manifest = {
		id,
		kind: input.kind,
		...input.title?.trim() ? { title: input.title.trim() } : {},
		...typeof input.preferredHeight === "number" ? { preferredHeight: input.preferredHeight } : {},
		...input.surface ? { surface: input.surface } : {},
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		entryUrl: entry.entryUrl,
		...entry.localEntrypoint ? { localEntrypoint: entry.localEntrypoint } : {},
		...entry.externalUrl ? { externalUrl: entry.externalUrl } : {},
		assets
	};
	await writeManifest(root$1, manifest);
	return manifest;
}
function resolveCanvasDocumentAssets(manifest, options) {
	const baseUrl = options?.baseUrl?.trim().replace(/\/+$/, "");
	const documentDir = resolveCanvasDocumentDir(manifest.id, {
		stateDir: options?.stateDir,
		rootDir: options?.canvasRootDir
	});
	return manifest.assets.map((asset) => ({
		logicalPath: asset.logicalPath,
		...asset.contentType ? { contentType: asset.contentType } : {},
		localPath: path.join(documentDir, asset.logicalPath),
		url: baseUrl ? `${baseUrl}${buildCanvasDocumentAssetUrl(manifest.id, asset.logicalPath)}` : buildCanvasDocumentAssetUrl(manifest.id, asset.logicalPath)
	}));
}
//#endregion
//#region extensions/canvas/src/host/server.ts
function defaultIndexHTML() {
	return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenClaw Canvas</title>
<style>
  html, body { height: 100%; margin: 0; background: #000; color: #fff; font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  .wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
  .card { width: min(720px, 100%); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 18px 18px 14px; }
  .title { display: flex; align-items: baseline; gap: 10px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: 0.2px; }
  .sub { opacity: 0.75; font-size: 13px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  button { appearance: none; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.10); color: #fff; padding: 10px 12px; border-radius: 12px; font-weight: 600; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .ok { color: #24e08a; }
  .bad { color: #ff5c5c; }
  .log { margin-top: 14px; opacity: 0.85; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); padding: 10px; border-radius: 12px; }
</style>
<div class="wrap">
  <div class="card">
    <div class="title">
      <h1>OpenClaw Canvas</h1>
      <div class="sub">Interactive test page (auto-reload enabled)</div>
    </div>

    <div class="row">
      <button id="btn-hello">Hello</button>
      <button id="btn-time">Time</button>
      <button id="btn-photo">Photo</button>
      <button id="btn-dalek">Dalek</button>
    </div>

    <div id="status" class="sub" style="margin-top: 10px;"></div>
    <div id="log" class="log">Ready.</div>
  </div>
</div>
<script>
(() => {
  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const log = (msg) => { logEl.textContent = String(msg); };

  const hasIOS = () =>
    !!(
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.openclawCanvasA2UIAction
    );
  const hasAndroid = () =>
    !!(
      (window.openclawCanvasA2UIAction &&
        typeof window.openclawCanvasA2UIAction.postMessage === "function")
    );
  const hasHelper = () => typeof window.openclawSendUserAction === "function";
  const helperReady = hasHelper();
  statusEl.textContent = "";
  statusEl.appendChild(document.createTextNode("Bridge: "));
  const bridgeStatus = document.createElement("span");
  bridgeStatus.className = helperReady ? "ok" : "bad";
  bridgeStatus.textContent = helperReady ? "ready" : "missing";
  statusEl.appendChild(bridgeStatus);
  statusEl.appendChild(
    document.createTextNode(
      " · iOS=" + (hasIOS() ? "yes" : "no") + " · Android=" + (hasAndroid() ? "yes" : "no"),
    ),
  );

  const onStatus = (ev) => {
    const d = ev && ev.detail || {};
    log("Action status: id=" + (d.id || "?") + " ok=" + String(!!d.ok) + (d.error ? (" error=" + d.error) : ""));
  };
  window.addEventListener("openclaw:a2ui-action-status", onStatus);

  function send(name, sourceComponentId) {
    if (!hasHelper()) {
      log("No action bridge found. Ensure you're viewing this on an iOS/Android OpenClaw node canvas.");
      return;
    }
    const sendUserAction =
      typeof window.openclawSendUserAction === "function"
        ? window.openclawSendUserAction
        : undefined;
    const ok = sendUserAction({
      name,
      surfaceId: "main",
      sourceComponentId,
      context: { t: Date.now() },
    });
    log(ok ? ("Sent action: " + name) : ("Failed to send action: " + name));
  }

  document.getElementById("btn-hello").onclick = () => send("hello", "demo.hello");
  document.getElementById("btn-time").onclick = () => send("time", "demo.time");
  document.getElementById("btn-photo").onclick = () => send("photo", "demo.photo");
  document.getElementById("btn-dalek").onclick = () => send("dalek", "demo.dalek");
})();
<\/script>
`;
}
function isDisabledByEnv() {
	if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) return true;
	if (process.env.VITEST) return true;
	return false;
}
function normalizeBasePath(rawPath) {
	const normalized = normalizeUrlPath((rawPath ?? "/__openclaw__/canvas").trim() || "/__openclaw__/canvas");
	if (normalized === "/") return "/";
	return normalized.replace(/\/+$/, "");
}
async function prepareCanvasRoot(rootDir) {
	await ensureDir(rootDir);
	const rootReal = await fs$1.realpath(rootDir);
	try {
		const indexPath = path.join(rootReal, "index.html");
		await fs$1.stat(indexPath);
	} catch {
		try {
			await fs$1.writeFile(path.join(rootReal, "index.html"), defaultIndexHTML(), "utf8");
		} catch {}
	}
	return rootReal;
}
function resolveDefaultCanvasRoot() {
	const candidates = [path.join(resolveStateDir(), "canvas")];
	return candidates.find((dir) => {
		try {
			return fsSync.statSync(dir).isDirectory();
		} catch {
			return false;
		}
	}) ?? candidates[0];
}
function resolveDefaultWatchFactory() {
	const importedWatch = chokidar?.watch;
	if (typeof importedWatch === "function") return importedWatch.bind(chokidar);
	const runtime = createRequire(import.meta.url)("chokidar");
	if (runtime && typeof runtime.watch === "function") return runtime.watch.bind(runtime);
	if (runtime?.default && typeof runtime.default.watch === "function") return runtime.default.watch.bind(runtime.default);
	throw new Error("chokidar.watch unavailable");
}
async function createCanvasHostHandler(opts) {
	const basePath = normalizeBasePath(opts.basePath);
	if (isDisabledByEnv() && opts.allowInTests !== true) return {
		rootDir: "",
		basePath,
		handleHttpRequest: async () => false,
		handleUpgrade: () => false,
		close: async () => {}
	};
	const rootDir = resolveUserPath(opts.rootDir ?? resolveDefaultCanvasRoot());
	const rootReal = await prepareCanvasRoot(rootDir);
	const liveReload = opts.liveReload !== false;
	const testMode = opts.allowInTests === true;
	const reloadDebounceMs = testMode ? 12 : 75;
	const writeStabilityThresholdMs = testMode ? 12 : 75;
	const writePollIntervalMs = testMode ? 5 : 10;
	const WebSocketServerClass = opts.webSocketServerClass ?? WebSocketServer;
	const wss = liveReload ? new WebSocketServerClass({ noServer: true }) : null;
	const sockets = /* @__PURE__ */ new Set();
	if (wss) wss.on("connection", (ws) => {
		sockets.add(ws);
		ws.on("close", () => sockets.delete(ws));
	});
	let debounce = null;
	const broadcastReload = () => {
		if (!liveReload) return;
		for (const ws of sockets) try {
			ws.send("reload");
		} catch {}
	};
	const scheduleReload = () => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = null;
			broadcastReload();
		}, reloadDebounceMs);
		if (!testMode) debounce.unref?.();
	};
	let watcherClosed = false;
	const watchFactory = opts.watchFactory ?? resolveDefaultWatchFactory();
	const watcher = liveReload ? watchFactory(rootReal, {
		ignoreInitial: true,
		awaitWriteFinish: {
			stabilityThreshold: writeStabilityThresholdMs,
			pollInterval: writePollIntervalMs
		},
		usePolling: testMode,
		ignored: [/(^|[\\/])\../, /(^|[\\/])node_modules([\\/]|$)/]
	}) : null;
	watcher?.on("all", () => scheduleReload());
	watcher?.on("error", (err) => {
		if (watcherClosed) return;
		watcherClosed = true;
		opts.runtime.error(`Canvas host watcher error: ${String(err)} (live reload disabled; consider plugins.entries.canvas.config.host.liveReload=false or a smaller plugins.entries.canvas.config.host.root)`);
		watcher.close().catch(() => {});
	});
	const handleUpgrade = (req, socket, head) => {
		if (!wss) return false;
		if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__openclaw__/ws") return false;
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
		return true;
	};
	const handleHttpRequest = async (req, res) => {
		const urlRaw = req.url;
		if (!urlRaw) return false;
		try {
			const url = new URL(urlRaw, "http://localhost");
			if (url.pathname === "/__openclaw__/ws") {
				res.statusCode = liveReload ? 426 : 404;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end(liveReload ? "upgrade required" : "not found");
				return true;
			}
			let urlPath = url.pathname;
			if (basePath !== "/") {
				if (urlPath !== basePath && !urlPath.startsWith(`${basePath}/`)) return false;
				urlPath = urlPath === basePath ? "/" : urlPath.slice(basePath.length) || "/";
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.statusCode = 405;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("Method Not Allowed");
				return true;
			}
			const opened = await resolveFileWithinRoot(rootReal, urlPath);
			if (!opened) {
				if (urlPath === "/" || urlPath.endsWith("/")) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(`<!doctype html><meta charset="utf-8" /><title>OpenClaw Canvas</title><pre>Missing file.\nCreate ${rootDir}/index.html</pre>`);
					return true;
				}
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("not found");
				return true;
			}
			const { handle, realPath } = opened;
			let data;
			try {
				data = await handle.readFile();
			} finally {
				await handle.close().catch(() => {});
			}
			const lower = lowercasePreservingWhitespace(realPath);
			const mime = lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html" : await detectMime({ filePath: realPath }) ?? "application/octet-stream";
			res.setHeader("Cache-Control", "no-store");
			if (mime === "text/html") {
				const html = data.toString("utf8");
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(liveReload ? injectCanvasLiveReload(html) : html);
				return true;
			}
			res.setHeader("Content-Type", mime);
			res.end(data);
			return true;
		} catch (err) {
			opts.runtime.error(`Canvas host request failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("error");
			return true;
		}
	};
	return {
		rootDir,
		basePath,
		handleHttpRequest,
		handleUpgrade,
		close: async () => {
			if (debounce) clearTimeout(debounce);
			watcherClosed = true;
			await watcher?.close().catch(() => {});
			for (const ws of sockets) try {
				ws.terminate?.();
			} catch {}
			if (wss) await new Promise((resolve) => wss.close(() => resolve()));
		}
	};
}
async function startCanvasHost(opts) {
	if (isDisabledByEnv() && opts.allowInTests !== true) return {
		port: 0,
		rootDir: "",
		close: async () => {}
	};
	const handler = opts.handler ?? await createCanvasHostHandler({
		runtime: opts.runtime,
		rootDir: opts.rootDir,
		basePath: "/__openclaw__/canvas",
		allowInTests: opts.allowInTests,
		liveReload: opts.liveReload,
		watchFactory: opts.watchFactory,
		webSocketServerClass: opts.webSocketServerClass
	});
	const ownsHandler = opts.ownsHandler ?? opts.handler === void 0;
	const bindHost = normalizeOptionalString(opts.listenHost) || "127.0.0.1";
	const server = http.createServer((req, res) => {
		if (lowercasePreservingWhitespace(req.headers.upgrade ?? "") === "websocket") return;
		(async () => {
			if (req.url && isA2uiPath(new URL(req.url, "http://localhost").pathname)) {
				const { handleA2uiHttpRequest } = await import("./a2ui-DLvKI_fD.js");
				if (await handleA2uiHttpRequest(req, res)) return;
			}
			if (await handler.handleHttpRequest(req, res)) return;
			res.statusCode = 404;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("Not Found");
		})().catch((err) => {
			opts.runtime.error(`Canvas host request failed: ${String(err)}`);
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.end("error");
		});
	});
	server.on("upgrade", (req, socket, head) => {
		if (handler.handleUpgrade(req, socket, head)) return;
		socket.destroy();
	});
	const listenPort = typeof opts.port === "number" && Number.isFinite(opts.port) && opts.port > 0 ? opts.port : 0;
	await new Promise((resolve, reject) => {
		const onError = (err) => {
			server.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(listenPort, bindHost);
	});
	const addr = server.address();
	const boundPort = typeof addr === "object" && addr ? addr.port : 0;
	opts.runtime.log(`canvas host listening on http://${bindHost}:${boundPort} (root ${handler.rootDir})`);
	return {
		port: boundPort,
		rootDir: handler.rootDir,
		close: async () => {
			if (ownsHandler) await handler.close();
			await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
		}
	};
}
//#endregion
export { resolveCanvasDocumentAssets as a, canvasConfigSchema as c, parseCanvasPluginConfig as d, resolveCanvasHostConfig as f, parseCanvasSnapshotPayload as g, canvasSnapshotTempPath as h, createCanvasDocument as i, isCanvasHostEnabled as l, registerNodesCanvasCommands as m, startCanvasHost as n, resolveCanvasDocumentDir as o, createDefaultCanvasCliDependencies as p, buildCanvasDocumentEntryUrl as r, resolveCanvasHttpPathToLocalPath as s, createCanvasHostHandler as t, isCanvasPluginEnabled as u };
