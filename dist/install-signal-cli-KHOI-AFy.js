import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as extractArchive } from "./archive-DBeZ8ywX.js";
import { t as CONFIG_DIR } from "./utils-sBTEdeml.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./temp-path-DllZid8c.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as resolveBrewExecutable } from "./brew-B6RYZvsE.js";
import { t as runPluginCommandWithTimeout } from "./run-command-DdGTMKGw.js";
import "./setup-tools-DuiMNzp5.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { createWriteStream } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
//#region extensions/signal/src/install-signal-cli.ts
const MAX_SIGNAL_CLI_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SIGNAL_CLI_DOWNLOAD_TIMEOUT_MS = 5 * 6e4;
const SIGNAL_CLI_RELEASE_INFO_TIMEOUT_MS = 3e4;
/** @internal Exported for testing. */
async function extractSignalCliArchive(archivePath, installRoot, timeoutMs) {
	await extractArchive({
		archivePath,
		destDir: installRoot,
		timeoutMs
	});
}
/** @internal Exported for testing. */
function looksLikeArchive(name) {
	return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
}
function isNodeReadableStream(value) {
	return Boolean(value && typeof value.pipe === "function");
}
function chunkByteLength(chunk) {
	if (typeof chunk === "string") return Buffer.byteLength(chunk);
	if (chunk instanceof Uint8Array) return chunk.byteLength;
	return Buffer.byteLength(String(chunk));
}
/**
* Pick a native release asset from the official GitHub releases.
*
* The official signal-cli releases only publish native (GraalVM) binaries for
* x86-64 Linux.  On architectures where no native asset is available this
* returns `undefined` so the caller can fall back to a different install
* strategy (e.g. Homebrew).
*/
/** @internal Exported for testing. */
function pickAsset(assets, platform, arch) {
	const archives = assets.filter((asset) => Boolean(asset.name && asset.browser_download_url)).filter((a) => looksLikeArchive(normalizeLowercaseStringOrEmpty(a.name)));
	const byName = (pattern) => archives.find((asset) => pattern.test(normalizeLowercaseStringOrEmpty(asset.name)));
	if (platform === "linux") {
		if (arch === "x64") return byName(/linux-native/) || byName(/linux/) || archives[0];
		return;
	}
	if (platform === "darwin") return byName(/macos|osx|darwin/) || archives[0];
	if (platform === "win32") return byName(/windows|win/) || archives[0];
	return archives[0];
}
/** @internal Exported for testing. */
async function downloadToFile(url, dest, maxRedirects = 5, maxBytes = MAX_SIGNAL_CLI_ARCHIVE_BYTES) {
	let completed = false;
	const { response, release } = await fetchWithSsrFGuard({
		url,
		maxRedirects,
		requireHttps: true,
		timeoutMs: SIGNAL_CLI_DOWNLOAD_TIMEOUT_MS,
		capture: false,
		auditContext: "signal-cli-install-archive"
	});
	try {
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status || "?"} downloading file`);
		const rawLength = response.headers.get("content-length");
		if (rawLength !== null) {
			const declaredLength = Number(rawLength);
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`signal-cli archive exceeds the ${maxBytes}-byte download cap (declared ${declaredLength}).`);
		}
		let totalBytes = 0;
		const body = response.body;
		await pipeline(isNodeReadableStream(body) ? body : Readable.fromWeb(body), new Transform({ transform(chunk, _encoding, callback) {
			totalBytes += chunkByteLength(chunk);
			if (totalBytes > maxBytes) {
				callback(/* @__PURE__ */ new Error(`signal-cli archive exceeded the ${maxBytes}-byte download cap.`));
				return;
			}
			callback(null, chunk);
		} }), createWriteStream(dest));
		completed = true;
	} finally {
		await release();
		if (!completed) await fs$1.rm(dest, { force: true }).catch(() => void 0);
	}
}
async function findSignalCliBinary(root) {
	const candidates = [];
	const enqueue = async (dir, depth) => {
		if (depth > 3) return;
		const entries = await fs$1.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await enqueue(full, depth + 1);
			else if (entry.isFile() && entry.name === "signal-cli") candidates.push(full);
		}
	};
	await enqueue(root, 0);
	return candidates[0] ?? null;
}
async function resolveBrewSignalCliPath(brewExe) {
	try {
		const result = await runPluginCommandWithTimeout({
			argv: [
				brewExe,
				"--prefix",
				"signal-cli"
			],
			timeoutMs: 1e4
		});
		if (result.code === 0 && result.stdout.trim()) {
			const prefix = result.stdout.trim();
			const candidate = path.join(prefix, "bin", "signal-cli");
			try {
				await fs$1.access(candidate);
				return candidate;
			} catch {
				return findSignalCliBinary(prefix);
			}
		}
	} catch {}
	return null;
}
async function installSignalCliViaBrew(runtime) {
	const brewExe = resolveBrewExecutable();
	if (!brewExe) return {
		ok: false,
		error: `No native signal-cli build is available for ${process.arch}. Install Homebrew (https://brew.sh) and try again, or install signal-cli manually.`
	};
	runtime.log(`Installing signal-cli via Homebrew (${brewExe})…`);
	const result = await runPluginCommandWithTimeout({
		argv: [
			brewExe,
			"install",
			"signal-cli"
		],
		timeoutMs: 15 * 6e4
	});
	if (result.code !== 0) return {
		ok: false,
		error: `brew install signal-cli failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`
	};
	const cliPath = await resolveBrewSignalCliPath(brewExe);
	if (!cliPath) return {
		ok: false,
		error: "brew install succeeded but signal-cli binary was not found."
	};
	let version;
	try {
		version = (await runPluginCommandWithTimeout({
			argv: [cliPath, "--version"],
			timeoutMs: 1e4
		})).stdout.trim().replace(/^signal-cli\s+/, "") || void 0;
	} catch {}
	return {
		ok: true,
		cliPath,
		version
	};
}
/** @internal Exported for testing. */
async function installSignalCliFromRelease(runtime) {
	const { response, release } = await fetchWithSsrFGuard({
		url: "https://api.github.com/repos/AsamK/signal-cli/releases/latest",
		maxRedirects: 5,
		requireHttps: true,
		timeoutMs: SIGNAL_CLI_RELEASE_INFO_TIMEOUT_MS,
		capture: false,
		auditContext: "signal-cli-release-info",
		init: { headers: {
			"User-Agent": "openclaw",
			Accept: "application/vnd.github+json"
		} }
	});
	let payload;
	try {
		if (!response.ok) return {
			ok: false,
			error: `Failed to fetch release info (${response.status})`
		};
		try {
			payload = await response.json();
		} catch {
			return {
				ok: false,
				error: "Failed to parse signal-cli release info."
			};
		}
	} finally {
		await release();
	}
	const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
	const asset = pickAsset(payload.assets ?? [], process.platform, process.arch);
	if (!asset) return {
		ok: false,
		error: "No compatible release asset found for this platform."
	};
	const tmpDir = await fs$1.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-signal-"));
	const archivePath = path.join(tmpDir, asset.name);
	runtime.log(`Downloading signal-cli ${version} (${asset.name})…`);
	await downloadToFile(asset.browser_download_url, archivePath);
	const installRoot = path.join(CONFIG_DIR, "tools", "signal-cli", version);
	await fs$1.mkdir(installRoot, { recursive: true });
	if (!looksLikeArchive(normalizeLowercaseStringOrEmpty(asset.name))) return {
		ok: false,
		error: `Unsupported archive type: ${asset.name}`
	};
	try {
		await extractSignalCliArchive(archivePath, installRoot, 6e4);
	} catch (err) {
		const message = formatErrorMessage(err);
		return {
			ok: false,
			error: `Failed to extract ${asset.name}: ${message}`
		};
	}
	const cliPath = await findSignalCliBinary(installRoot);
	if (!cliPath) return {
		ok: false,
		error: `signal-cli binary not found after extracting ${asset.name}`
	};
	await fs$1.chmod(cliPath, 493).catch(() => {});
	return {
		ok: true,
		cliPath,
		version
	};
}
async function installSignalCli(runtime) {
	if (process.platform === "win32") return {
		ok: false,
		error: "Signal CLI auto-install is not supported on Windows yet."
	};
	if (process.platform !== "linux" || process.arch === "x64") return installSignalCliFromRelease(runtime);
	return installSignalCliViaBrew(runtime);
}
//#endregion
export { looksLikeArchive as a, installSignalCliFromRelease as i, extractSignalCliArchive as n, pickAsset as o, installSignalCli as r, downloadToFile as t };
