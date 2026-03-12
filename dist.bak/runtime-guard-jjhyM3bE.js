import { v as defaultRuntime } from "./entry.js";
import process from "node:process";

//#region src/infra/runtime-guard.ts
const MIN_NODE = {
	major: 22,
	minor: 12,
	patch: 0
};
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
function parseSemver(version) {
	if (!version) return null;
	const match = version.match(SEMVER_RE);
	if (!match) return null;
	const [, major, minor, patch] = match;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10)
	};
}
function isAtLeast(version, minimum) {
	if (!version) return false;
	if (version.major !== minimum.major) return version.major > minimum.major;
	if (version.minor !== minimum.minor) return version.minor > minimum.minor;
	return version.patch >= minimum.patch;
}
function detectRuntime() {
	return {
		kind: process.versions?.node ? "node" : "unknown",
		version: process.versions?.node ?? null,
		execPath: process.execPath ?? null,
		pathEnv: process.env.PATH ?? "(not set)"
	};
}
function runtimeSatisfies(details) {
	const parsed = parseSemver(details.version);
	if (details.kind === "node") return isAtLeast(parsed, MIN_NODE);
	return false;
}
function isSupportedNodeVersion(version) {
	return isAtLeast(parseSemver(version), MIN_NODE);
}
function assertSupportedRuntime(runtime = defaultRuntime, details = detectRuntime()) {
	if (runtimeSatisfies(details)) return;
	const versionLabel = details.version ?? "unknown";
	const runtimeLabel = details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
	const execLabel = details.execPath ?? "unknown";
	runtime.error([
		"openclaw requires Node >=22.12.0.",
		`Detected: ${runtimeLabel} (exec: ${execLabel}).`,
		`PATH searched: ${details.pathEnv}`,
		"Install Node: https://nodejs.org/en/download",
		"Upgrade Node and re-run openclaw."
	].join("\n"));
	runtime.exit(1);
}

//#endregion
export { isSupportedNodeVersion as n, parseSemver as r, assertSupportedRuntime as t };