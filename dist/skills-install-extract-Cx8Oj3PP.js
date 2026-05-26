import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { a as prepareArchiveDestinationDir, i as mergeExtractedTreeIntoDestination, o as withStagedArchiveDestination, r as createTarEntryPreflightChecker, t as extractArchive$1 } from "./archive-DBeZ8ywX.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import "./archive-CBe_wA_B.js";
import { n as hasBinary } from "./config-eval-BH8jfSqo.js";
import "./skills-JUNRkaHl.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
//#region src/agents/skills-install-tar-verbose.ts
const TAR_VERBOSE_MONTHS = new Set([
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec"
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function mapTarVerboseTypeChar(typeChar) {
	switch (typeChar) {
		case "l": return "SymbolicLink";
		case "h": return "Link";
		case "b": return "BlockDevice";
		case "c": return "CharacterDevice";
		case "p": return "FIFO";
		case "s": return "Socket";
		case "d": return "Directory";
		default: return "File";
	}
}
function parseTarVerboseSize(line) {
	const tokens = line.trim().split(/\s+/).filter(Boolean);
	if (tokens.length < 6) throw new Error(`unable to parse tar verbose metadata: ${line}`);
	let dateIndex = tokens.findIndex((token) => TAR_VERBOSE_MONTHS.has(token));
	if (dateIndex > 0) {
		const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
		if (!Number.isFinite(size) || size < 0) throw new Error(`unable to parse tar entry size: ${line}`);
		return size;
	}
	dateIndex = tokens.findIndex((token) => ISO_DATE_PATTERN.test(token));
	if (dateIndex > 0) {
		const size = Number.parseInt(tokens[dateIndex - 1] ?? "", 10);
		if (!Number.isFinite(size) || size < 0) throw new Error(`unable to parse tar entry size: ${line}`);
		return size;
	}
	throw new Error(`unable to parse tar verbose metadata: ${line}`);
}
function parseTarVerboseMetadata(stdout) {
	return stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
		const typeChar = line[0] ?? "";
		if (!typeChar) throw new Error("unable to parse tar entry type");
		return {
			type: mapTarVerboseTypeChar(typeChar),
			size: parseTarVerboseSize(line)
		};
	});
}
//#endregion
//#region src/agents/skills-install-extract.ts
async function hashFileSha256(filePath) {
	const hash = createHash("sha256");
	const stream = fs.createReadStream(filePath);
	return await new Promise((resolve, reject) => {
		stream.on("data", (chunk) => {
			hash.update(chunk);
		});
		stream.on("error", reject);
		stream.on("end", () => {
			resolve(hash.digest("hex"));
		});
	});
}
function commandFailureResult(result, fallbackStderr) {
	return {
		stdout: result.stdout,
		stderr: result.stderr || fallbackStderr,
		code: result.code
	};
}
function buildTarExtractArgv(params) {
	const argv = [
		"tar",
		"xf",
		params.archivePath,
		"-C",
		params.targetDir
	];
	if (params.stripComponents > 0) argv.push("--strip-components", String(params.stripComponents));
	return argv;
}
async function readTarPreflight(params) {
	const listResult = await runCommandWithTimeout([
		"tar",
		"tf",
		params.archivePath
	], { timeoutMs: params.timeoutMs });
	if (listResult.code !== 0) return commandFailureResult(listResult, "tar list failed");
	const entries = listResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	const verboseResult = await runCommandWithTimeout([
		"tar",
		"tvf",
		params.archivePath
	], { timeoutMs: params.timeoutMs });
	if (verboseResult.code !== 0) return commandFailureResult(verboseResult, "tar verbose list failed");
	const metadata = parseTarVerboseMetadata(verboseResult.stdout);
	if (metadata.length !== entries.length) return {
		stdout: verboseResult.stdout,
		stderr: `tar verbose/list entry count mismatch (${metadata.length} vs ${entries.length})`,
		code: 1
	};
	return {
		entries,
		metadata
	};
}
function isArchiveExtractFailure(value) {
	return "code" in value;
}
async function verifyArchiveHashStable(params) {
	if (await hashFileSha256(params.archivePath) === params.expectedHash) return null;
	return {
		stdout: "",
		stderr: "tar archive changed during safety preflight; refusing to extract",
		code: 1
	};
}
async function extractTarBz2WithStaging(params) {
	return await withStagedArchiveDestination({
		destinationRealDir: params.destinationRealDir,
		run: async (stagingDir) => {
			const extractResult = await runCommandWithTimeout(buildTarExtractArgv({
				archivePath: params.archivePath,
				targetDir: stagingDir,
				stripComponents: params.stripComponents
			}), { timeoutMs: params.timeoutMs });
			if (extractResult.code !== 0) return extractResult;
			await mergeExtractedTreeIntoDestination({
				sourceDir: stagingDir,
				destinationDir: params.destinationRealDir,
				destinationRealDir: params.destinationRealDir
			});
			return extractResult;
		}
	});
}
async function extractArchive(params) {
	const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
	const strip = typeof stripComponents === "number" && Number.isFinite(stripComponents) ? Math.max(0, Math.floor(stripComponents)) : 0;
	try {
		if (archiveType === "zip") {
			await extractArchive$1({
				archivePath,
				destDir: targetDir,
				timeoutMs,
				kind: "zip",
				stripComponents: strip
			});
			return {
				stdout: "",
				stderr: "",
				code: 0
			};
		}
		if (archiveType === "tar.gz") {
			await extractArchive$1({
				archivePath,
				destDir: targetDir,
				timeoutMs,
				kind: "tar",
				stripComponents: strip,
				tarGzip: true
			});
			return {
				stdout: "",
				stderr: "",
				code: 0
			};
		}
		if (archiveType === "tar.bz2") {
			if (!hasBinary("tar")) return {
				stdout: "",
				stderr: "tar not found on PATH",
				code: null
			};
			const destinationRealDir = await prepareArchiveDestinationDir(targetDir);
			const preflightHash = await hashFileSha256(archivePath);
			const preflight = await readTarPreflight({
				archivePath,
				timeoutMs
			});
			if (isArchiveExtractFailure(preflight)) return preflight;
			const checkTarEntrySafety = createTarEntryPreflightChecker({
				rootDir: destinationRealDir,
				stripComponents: strip,
				escapeLabel: "targetDir"
			});
			for (let i = 0; i < preflight.entries.length; i += 1) {
				const entryPath = preflight.entries[i];
				const entryMeta = preflight.metadata[i];
				if (!entryPath || !entryMeta) return {
					stdout: "",
					stderr: "tar metadata parse failure",
					code: 1
				};
				checkTarEntrySafety({
					path: entryPath,
					type: entryMeta.type,
					size: entryMeta.size
				});
			}
			const hashFailure = await verifyArchiveHashStable({
				archivePath,
				expectedHash: preflightHash
			});
			if (hashFailure) return hashFailure;
			return await extractTarBz2WithStaging({
				archivePath,
				destinationRealDir,
				stripComponents: strip,
				timeoutMs
			});
		}
		return {
			stdout: "",
			stderr: `unsupported archive type: ${archiveType}`,
			code: null
		};
	} catch (err) {
		return {
			stdout: "",
			stderr: formatErrorMessage(err),
			code: 1
		};
	}
}
//#endregion
export { extractArchive };
