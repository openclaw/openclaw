import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CRSCIPqz.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/plugins/plugin-peer-link.ts
function readStringRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const record = {};
	for (const [key, raw] of Object.entries(value)) if (typeof raw === "string") record[key] = raw;
	return record;
}
async function readPackagePeerDependencies(packageDir) {
	try {
		const raw = await fs.readFile(path.join(packageDir, "package.json"), "utf8");
		return readStringRecord(JSON.parse(raw).peerDependencies);
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
}
async function listManagedNpmRootPackageDirs(npmRoot) {
	const nodeModulesDir = path.join(npmRoot, "node_modules");
	let entries;
	try {
		entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const packageDirs = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === ".bin") continue;
		const entryPath = path.join(nodeModulesDir, entry.name);
		if (entry.name.startsWith("@")) {
			const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true }).catch((error) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			for (const scopedEntry of scopedEntries) if (scopedEntry.isDirectory()) packageDirs.push(path.join(entryPath, scopedEntry.name));
			continue;
		}
		if (!entry.name.startsWith(".")) packageDirs.push(entryPath);
	}
	return packageDirs.toSorted((a, b) => a.localeCompare(b));
}
/**
* Symlink the host openclaw package for plugins that declare it as a peer.
* Plugin package managers still own third-party dependencies; this only wires
* the host SDK package into the plugin-local Node graph.
*/
async function linkOpenClawPeerDependencies(params) {
	const peers = Object.keys(params.peerDependencies).filter((name) => name === "openclaw");
	if (peers.length === 0) return;
	const hostRoot = resolveOpenClawPackageRootSync({
		argv1: process.argv[1],
		moduleUrl: import.meta.url,
		cwd: process.cwd()
	});
	if (!hostRoot) {
		params.logger.warn?.("Could not locate openclaw package root to symlink peerDependencies; plugin may fail to resolve openclaw at runtime.");
		return;
	}
	const nodeModulesDir = path.join(params.installedDir, "node_modules");
	await fs.mkdir(nodeModulesDir, { recursive: true });
	for (const peerName of peers) {
		const linkPath = path.join(nodeModulesDir, peerName);
		try {
			await fs.rm(linkPath, {
				recursive: true,
				force: true
			});
			await fs.symlink(hostRoot, linkPath, "junction");
			params.logger.info?.(`Linked peerDependency "${peerName}" -> ${hostRoot}`);
		} catch (err) {
			params.logger.warn?.(`Failed to symlink peerDependency "${peerName}": ${String(err)}`);
		}
	}
}
async function relinkOpenClawPeerDependenciesInManagedNpmRoot(params) {
	let checked = 0;
	let attempted = 0;
	for (const packageDir of await listManagedNpmRootPackageDirs(params.npmRoot)) {
		const peerDependencies = await readPackagePeerDependencies(packageDir);
		if (!Object.hasOwn(peerDependencies, "openclaw")) continue;
		checked += 1;
		await linkOpenClawPeerDependencies({
			installedDir: packageDir,
			peerDependencies,
			logger: params.logger
		});
		attempted += 1;
	}
	return {
		checked,
		attempted
	};
}
//#endregion
export { relinkOpenClawPeerDependenciesInManagedNpmRoot as n, linkOpenClawPeerDependencies as t };
