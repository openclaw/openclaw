import "./fs-safe-defaults-B7hUN42l.js";
import { n as registerTempPathForExit } from "./write-queue-C9nceBqy.js";
import { i as openRootFileSync } from "./root-file-jRMCpJW4.js";
import { n as fileStoreSync, t as fileStore } from "./file-store-BcfkC1se.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region node_modules/@openclaw/fs-safe/dist/private-temp-workspace.js
function sanitizeTempPrefix(prefix) {
	const sanitized = prefix.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!sanitized || sanitized === "." || sanitized === "..") return "fs-safe-";
	return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}
function resolveWorkspaceLeaf(dir, fileName) {
	return path.join(dir, assertWorkspaceFileName(fileName));
}
function assertWorkspaceFileName(fileName) {
	const value = fileName.trim();
	if (!value || value === "." || value === ".." || value.includes("\0") || value.includes("/") || value.includes("\\") || path.basename(value) !== value) throw new Error(`Invalid temp workspace file name: ${JSON.stringify(fileName)}`);
	return value;
}
async function ensurePrivateDirectory(dir, mode) {
	await fs$1.mkdir(dir, {
		recursive: true,
		mode
	});
	if (!(await fs$1.stat(dir)).isDirectory()) throw new Error(`Temp root must be a directory: ${dir}`);
	await fs$1.chmod(dir, mode).catch(() => void 0);
}
function ensurePrivateDirectorySync(dir, mode) {
	fs.mkdirSync(dir, {
		recursive: true,
		mode
	});
	if (!fs.statSync(dir).isDirectory()) throw new Error(`Temp root must be a directory: ${dir}`);
	try {
		fs.chmodSync(dir, mode);
	} catch {}
}
async function createTempWorkspace(options) {
	const dirMode = options.dirMode ?? 448;
	const mode = options.mode ?? 384;
	const requestedRoot = path.resolve(options.rootDir);
	const root = await fs$1.realpath(requestedRoot).catch(() => requestedRoot);
	await ensurePrivateDirectory(root, dirMode);
	const dir = await fs$1.mkdtemp(path.join(root, sanitizeTempPrefix(options.prefix)));
	const unregisterTempDir = registerTempPathForExit(dir, { recursive: true });
	await fs$1.chmod(dir, dirMode).catch(() => void 0);
	const stat = await fs$1.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Temp workspace must be a directory: ${dir}`);
	const store = fileStore({
		rootDir: dir,
		private: true,
		dirMode,
		mode
	});
	return {
		dir,
		store,
		path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
		write: async (fileName, data) => await store.write(assertWorkspaceFileName(fileName), data, { mode }),
		writeText: async (fileName, data) => await store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
		writeJson: async (fileName, data, writeOptions) => await store.writeJson(assertWorkspaceFileName(fileName), data, {
			mode,
			trailingNewline: writeOptions?.trailingNewline
		}),
		copyIn: async (fileName, sourcePath) => await store.copyIn(assertWorkspaceFileName(fileName), sourcePath, { mode }),
		read: async (fileName) => await store.readBytes(assertWorkspaceFileName(fileName)),
		cleanup: async () => {
			try {
				await fs$1.rm(dir, {
					recursive: true,
					force: true
				}).catch(() => void 0);
			} finally {
				unregisterTempDir();
			}
		},
		[Symbol.asyncDispose]: async () => {
			try {
				await fs$1.rm(dir, {
					recursive: true,
					force: true
				}).catch(() => void 0);
			} finally {
				unregisterTempDir();
			}
		}
	};
}
async function tempWorkspace(options) {
	return await createTempWorkspace(options);
}
async function withTempWorkspace(options, run) {
	const workspace = await createTempWorkspace({
		...options,
		prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`
	});
	try {
		return await run(workspace);
	} finally {
		await workspace.cleanup();
	}
}
function tempWorkspaceSync(options) {
	const dirMode = options.dirMode ?? 448;
	const mode = options.mode ?? 384;
	const requestedRoot = path.resolve(options.rootDir);
	let root = requestedRoot;
	try {
		root = fs.realpathSync.native(requestedRoot);
	} catch {
		root = requestedRoot;
	}
	ensurePrivateDirectorySync(root, dirMode);
	const dir = fs.mkdtempSync(path.join(root, sanitizeTempPrefix(options.prefix)));
	const unregisterTempDir = registerTempPathForExit(dir, { recursive: true });
	try {
		fs.chmodSync(dir, dirMode);
	} catch {}
	const stat = fs.lstatSync(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Temp workspace must be a directory: ${dir}`);
	const store = fileStoreSync({
		rootDir: dir,
		private: true,
		dirMode,
		mode
	});
	return {
		dir,
		store,
		path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
		write: (fileName, data) => store.write(assertWorkspaceFileName(fileName), data, { mode }),
		writeText: (fileName, data) => store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
		writeJson: (fileName, data, writeOptions) => store.writeJson(assertWorkspaceFileName(fileName), data, {
			mode,
			trailingNewline: writeOptions?.trailingNewline
		}),
		read: (fileName) => {
			const opened = openRootFileSync({
				absolutePath: store.path(assertWorkspaceFileName(fileName)),
				rootPath: dir,
				boundaryLabel: "temp workspace",
				rejectHardlinks: true
			});
			if (!opened.ok) throw Object.assign(/* @__PURE__ */ new Error(`File not found: ${fileName}`), { code: "ENOENT" });
			try {
				return fs.readFileSync(opened.fd);
			} finally {
				fs.closeSync(opened.fd);
			}
		},
		cleanup: () => {
			try {
				fs.rmSync(dir, {
					recursive: true,
					force: true
				});
			} catch {} finally {
				unregisterTempDir();
			}
		},
		[Symbol.dispose]: () => {
			try {
				fs.rmSync(dir, {
					recursive: true,
					force: true
				});
			} catch {} finally {
				unregisterTempDir();
			}
		}
	};
}
function withTempWorkspaceSync(options, run) {
	const workspace = tempWorkspaceSync({
		...options,
		prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`
	});
	try {
		return run(workspace);
	} finally {
		workspace.cleanup();
	}
}
//#endregion
export { withTempWorkspaceSync as i, tempWorkspaceSync as n, withTempWorkspace as r, tempWorkspace as t };
