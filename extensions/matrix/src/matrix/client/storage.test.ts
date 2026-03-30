import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMatrixAccountStorageRoot } from "../../../runtime-api.js";

const createBackupArchiveMock = vi.hoisted(() =>
	vi.fn(async (_params: unknown) => ({
		createdAt: "2026-03-17T00:00:00.000Z",
		archiveRoot: "2026-03-17-openclaw-backup",
		archivePath: "/tmp/matrix-migration-snapshot.tar.gz",
		dryRun: false,
		includeWorkspace: false,
		onlyConfig: false,
		verified: false,
		assets: [],
		skipped: [],
	})),
);

vi.mock("../../../../../src/infra/backup-create.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../../../src/infra/backup-create.js")
		>();
	return {
		...actual,
		createBackupArchive: (params: unknown) => createBackupArchiveMock(params),
	};
});

let maybeMigrateLegacyStorage: typeof import("./storage.js").maybeMigrateLegacyStorage;
let resolveMatrixStateFilePath: typeof import("./storage.js").resolveMatrixStateFilePath;
let resolveMatrixStoragePaths: typeof import("./storage.js").resolveMatrixStoragePaths;
let installMatrixTestRuntime: typeof import("../../test-runtime.js").installMatrixTestRuntime;

describe("matrix client storage paths", () => {
	const tempDirs: string[] = [];
	const defaultStorageAuth = {
		homeserver: "https://matrix.example.org",
		userId: "@bot:example.org",
		accessToken: "secret-token",
	};

	beforeEach(async () => {
		vi.resetModules();
		({ installMatrixTestRuntime } = await import("../../test-runtime.js"));
		({
			maybeMigrateLegacyStorage,
			resolveMatrixStateFilePath,
			resolveMatrixStoragePaths,
		} = await import("./storage.js"));
	});

	afterEach(() => {
		createBackupArchiveMock.mockReset();
		createBackupArchiveMock.mockImplementation(async (_params: unknown) => ({
			createdAt: "2026-03-17T00:00:00.000Z",
			archiveRoot: "2026-03-17-openclaw-backup",
			archivePath: "/tmp/matrix-migration-snapshot.tar.gz",
			dryRun: false,
			includeWorkspace: false,
			onlyConfig: false,
			verified: false,
			assets: [],
			skipped: [],
		}));
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function setupStateDir(
		cfg: Record<string, unknown> = {
			channels: {
				matrix: {},
			},
		},
	): string {
		const homeDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "openclaw-matrix-storage-"),
		);
		const stateDir = path.join(homeDir, ".openclaw");
		fs.mkdirSync(stateDir, { recursive: true });
		tempDirs.push(homeDir);
		installMatrixTestRuntime({
			cfg,
			logging: {
				getChildLogger: () => ({
					info: () => {},
					warn: () => {},
					error: () => {},
				}),
			},
			stateDir,
		});
		return stateDir;
	}

	function createMigrationEnv(stateDir: string): NodeJS.ProcessEnv {
		return {
			HOME: path.dirname(stateDir),
			OPENCLAW_HOME: path.dirname(stateDir),
			OPENCLAW_STATE_DIR: stateDir,
			OPENCLAW_TEST_FAST: "1",
		} as NodeJS.ProcessEnv;
	}

	function resolveDefaultStoragePaths(
		overrides: Partial<{
			homeserver: string;
			userId: string;
			accessToken: string;
			accountId: string;
			deviceId: string;
		}> = {},
	) {
		return resolveMatrixStoragePaths({
			...defaultStorageAuth,
			...overrides,
			env: {},
		});
	}

	it("resolves state file paths inside the selected storage root", () => {
		setupStateDir();
		const filePath = resolveMatrixStateFilePath({
			auth: {
				...defaultStorageAuth,
				accountId: "ops",
				deviceId: "DEVICE1",
			},
			filename: "thread-bindings.json",
			env: {},
		});

		expect(filePath).toBe(
			path.join(
				resolveDefaultStoragePaths({ accountId: "ops", deviceId: "DEVICE1" })
					.rootDir,
				"thread-bindings.json",
			),
		);
	});

	function writeLegacyMatrixStorage(
		stateDir: string,
		params: {
			storageBody?: string;
			withCrypto?: boolean;
		} = {},
	) {
		const legacyRoot = path.join(stateDir, "matrix");
		if (params.withCrypto ?? true) {
			fs.mkdirSync(path.join(legacyRoot, "crypto"), { recursive: true });
		}
		if (params.storageBody !== undefined) {
			fs.writeFileSync(
				path.join(legacyRoot, "bot-storage.json"),
				params.storageBody,
			);
		}
		return legacyRoot;
	}

	function writeJson(
		rootDir: string,
		filename: string,
		value: Record<string, unknown>,
	) {
		fs.writeFileSync(
			path.join(rootDir, filename),
			JSON.stringify(value, null, 2),
		);
	}

	function seedExistingStorageRoot(params: {
		accessToken: string;
		deviceId?: string;
		storageBody?: string;
		storageMeta?: Record<string, unknown>;
		startupVerificationDeviceId?: string;
	}) {
		const storagePaths = resolveDefaultStoragePaths({
			accessToken: params.accessToken,
			...(params.deviceId ? { deviceId: params.deviceId } : {}),
		});
		fs.mkdirSync(storagePaths.rootDir, { recursive: true });
		fs.writeFileSync(
			storagePaths.storagePath,
			params.storageBody ?? '{"legacy":true}',
		);
		if (params.storageMeta) {
			writeJson(storagePaths.rootDir, "storage-meta.json", params.storageMeta);
		}
		if (params.startupVerificationDeviceId) {
			writeJson(storagePaths.rootDir, "startup-verification.json", {
				deviceId: params.startupVerificationDeviceId,
			});
		}
		return storagePaths;
	}

	function seedCanonicalStorageRoot(params: {
		stateDir: string;
		accessToken: string;
		storageMeta: Record<string, unknown>;
	}) {
		const canonicalPaths = resolveMatrixAccountStorageRoot({
			stateDir: params.stateDir,
			homeserver: defaultStorageAuth.homeserver,
			userId: defaultStorageAuth.userId,
			accessToken: params.accessToken,
		});
		fs.mkdirSync(canonicalPaths.rootDir, { recursive: true });
		writeJson(canonicalPaths.rootDir, "storage-meta.json", params.storageMeta);
		return canonicalPaths;
	}

	function expectCanonicalRootForNewDevice(stateDir: string) {
		const newerCanonicalPaths = seedCanonicalStorageRoot({
			stateDir,
			accessToken: "secret-token-new",
			storageMeta: {
				homeserver: defaultStorageAuth.homeserver,
				userId: defaultStorageAuth.userId,
				accountId: "default",
				accessTokenHash: resolveDefaultStoragePaths({
					accessToken: "secret-token-new",
				}).tokenHash,
				deviceId: "NEWDEVICE",
			},
		});

		const resolvedPaths = resolveDefaultStoragePaths({
			accessToken: "secret-token-new",
			deviceId: "NEWDEVICE",
		});

		expect(resolvedPaths.rootDir).toBe(newerCanonicalPaths.rootDir);
		expect(resolvedPaths.tokenHash).toBe(newerCanonicalPaths.tokenHash);
	}

	it("uses the simplified matrix runtime root for account-scoped storage", () => {
		const stateDir = setupStateDir();

		const storagePaths = resolveMatrixStoragePaths({
			homeserver: "https://matrix.example.org",
			userId: "@Bot:example.org",
			accessToken: "secret-token",
			accountId: "ops",
			env: {},
		});

		expect(storagePaths.rootDir).toBe(
			path.join(
				stateDir,
				"matrix",
				"accounts",
				"ops",
				"matrix.example.org__bot_example.org",
				storagePaths.tokenHash,
			),
		);
		expect(storagePaths.storagePath).toBe(
			path.join(storagePaths.rootDir, "bot-storage.json"),
		);
		expect(storagePaths.cryptoPath).toBe(
			path.join(storagePaths.rootDir, "crypto"),
		);
		expect(storagePaths.metaPath).toBe(
			path.join(storagePaths.rootDir, "storage-meta.json"),
		);
		expect(storagePaths.recoveryKeyPath).toBe(
			path.join(storagePaths.rootDir, "recovery-key.json"),
		);
		expect(storagePaths.idbSnapshotPath).toBe(
			path.join(storagePaths.rootDir, "crypto-idb-snapshot.json"),
		);
	});

	it("falls back to migrating the older flat matrix storage layout", async () => {
		const stateDir = setupStateDir();
		const storagePaths = resolveDefaultStoragePaths();
		const legacyRoot = writeLegacyMatrixStorage(stateDir, {
			storageBody: '{"legacy":true}',
		});
		const env = createMigrationEnv(stateDir);

		await maybeMigrateLegacyStorage({
			storagePaths,
			env,
		});

		expect(createBackupArchiveMock).toHaveBeenCalledWith(
			expect.objectContaining({ includeWorkspace: false }),
		);
		expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(
			false,
		);
		expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe(
			'{"legacy":true}',
		);
		expect(fs.existsSync(storagePaths.cryptoPath)).toBe(true);
	});

	it("continues migrating whichever legacy artifact is still missing", async () => {
		const stateDir = setupStateDir();
		const storagePaths = resolveDefaultStoragePaths();
		const legacyRoot = writeLegacyMatrixStorage(stateDir);
		const env = createMigrationEnv(stateDir);
		fs.mkdirSync(storagePaths.rootDir, { recursive: true });
		fs.writeFileSync(storagePaths.storagePath, '{"new":true}');

		await maybeMigrateLegacyStorage({
			storagePaths,
			env,
		});

		expect(createBackupArchiveMock).toHaveBeenCalledWith(
			expect.objectContaining({ includeWorkspace: false }),
		);
		expect(fs.readFileSync(storagePaths.storagePath, "utf8")).toBe(
			'{"new":true}',
		);
		expect(fs.existsSync(path.join(legacyRoot, "crypto"))).toBe(false);
		expect(fs.existsSync(storagePaths.cryptoPath)).toBe(true);
	});

	it("refuses to migrate legacy storage when the snapshot step fails", async () => {
		const stateDir = setupStateDir();
		const storagePaths = resolveDefaultStoragePaths();
		const legacyRoot = writeLegacyMatrixStorage(stateDir, {
			storageBody: '{"legacy":true}',
		});
		const env = createMigrationEnv(stateDir);
		createBackupArchiveMock.mockRejectedValueOnce(new Error("snapshot failed"));

		await expect(
			maybeMigrateLegacyStorage({
				storagePaths,
				env,
			}),
		).rejects.toThrow("snapshot failed");
		expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
		expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
	});

	it("rolls back moved legacy storage when the crypto move fails", async () => {
		const stateDir = setupStateDir();
		const storagePaths = resolveDefaultStoragePaths();
		const legacyRoot = writeLegacyMatrixStorage(stateDir, {
			storageBody: '{"legacy":true}',
		});
		const env = createMigrationEnv(stateDir);
		const realRenameSync = fs.renameSync.bind(fs);
		const renameSync = vi.spyOn(fs, "renameSync");
		renameSync.mockImplementation((sourcePath, targetPath) => {
			if (String(targetPath) === storagePaths.cryptoPath) {
				throw new Error("disk full");
			}
			return realRenameSync(sourcePath, targetPath);
		});

		await expect(
			maybeMigrateLegacyStorage({
				storagePaths,
				env,
			}),
		).rejects.toThrow("disk full");
		expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
		expect(fs.existsSync(storagePaths.storagePath)).toBe(false);
		expect(fs.existsSync(path.join(legacyRoot, "crypto"))).toBe(true);
	});

	it("refuses fallback migration when multiple Matrix accounts need explicit selection", async () => {
		const stateDir = setupStateDir({
			channels: {
				matrix: {
					accounts: {
						ops: {},
						work: {},
					},
				},
			},
		});
		const storagePaths = resolveDefaultStoragePaths({ accountId: "ops" });
		const legacyRoot = writeLegacyMatrixStorage(stateDir, {
			storageBody: '{"legacy":true}',
		});
		const env = createMigrationEnv(stateDir);

		await expect(
			maybeMigrateLegacyStorage({
				storagePaths,
				env,
			}),
		).rejects.toThrow(/defaultAccount is not set/i);
		expect(createBackupArchiveMock).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
	});

	it("refuses fallback migration for a non-selected Matrix account", async () => {
		const stateDir = setupStateDir({
			channels: {
				matrix: {
					defaultAccount: "ops",
					homeserver: "https://matrix.default.example.org",
					accessToken: "default-token",
					accounts: {
						ops: {
							homeserver: "https://matrix.ops.example.org",
							accessToken: "ops-token",
						},
					},
				},
			},
		});
		const storagePaths = resolveMatrixStoragePaths({
			homeserver: "https://matrix.default.example.org",
			userId: "@default:example.org",
			accessToken: "default-token",
			env: {},
		});
		const legacyRoot = writeLegacyMatrixStorage(stateDir, {
			storageBody: '{"legacy":true}',
		});
		const env = createMigrationEnv(stateDir);

		await expect(
			maybeMigrateLegacyStorage({
				storagePaths,
				env,
			}),
		).rejects.toThrow(/targets account "ops"/i);
		expect(createBackupArchiveMock).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(legacyRoot, "bot-storage.json"))).toBe(true);
	});

	it("reuses an existing token-hash storage root after the access token changes", () => {
		setupStateDir();
		const oldStoragePaths = seedExistingStorageRoot({
			accessToken: "secret-token-old",
		});

		const rotatedStoragePaths = resolveDefaultStoragePaths({
			accessToken: "secret-token-new",
		});

		expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
		expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
		expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
	});

	it("reuses an existing token-hash storage root for the same device after the access token changes", () => {
		setupStateDir();
		const oldStoragePaths = seedExistingStorageRoot({
			accessToken: "secret-token-old",
			deviceId: "DEVICE123",
			storageMeta: {
				homeserver: defaultStorageAuth.homeserver,
				userId: defaultStorageAuth.userId,
				accountId: "default",
				accessTokenHash: resolveDefaultStoragePaths({
					accessToken: "secret-token-old",
				}).tokenHash,
				deviceId: "DEVICE123",
			},
		});

		const rotatedStoragePaths = resolveDefaultStoragePaths({
			accessToken: "secret-token-new",
			deviceId: "DEVICE123",
		});

		expect(rotatedStoragePaths.rootDir).toBe(oldStoragePaths.rootDir);
		expect(rotatedStoragePaths.tokenHash).toBe(oldStoragePaths.tokenHash);
		expect(rotatedStoragePaths.storagePath).toBe(oldStoragePaths.storagePath);
	});

	it("prefers a populated older token-hash storage root over a newer empty root", () => {
		const stateDir = setupStateDir();
		const oldStoragePaths = seedExistingStorageRoot({
			accessToken: "secret-token-old",
		});

		const _newerCanonicalPaths = seedCanonicalStorageRoot({
			stateDir,
			accessToken: "secret-token-new",
			storageMeta: {
				accessTokenHash: resolveDefaultStoragePaths({
					accessToken: "secret-token-new",
				}).tokenHash,
			},
		});

		const resolvedPaths = resolveDefaultStoragePaths({
			accessToken: "secret-token-new",
		});

		expect(resolvedPaths.rootDir).toBe(oldStoragePaths.rootDir);
		expect(resolvedPaths.tokenHash).toBe(oldStoragePaths.tokenHash);
	});

	it("does not reuse a populated sibling storage root from a different device", () => {
		const stateDir = setupStateDir();
		seedExistingStorageRoot({
			accessToken: "secret-token-old",
			deviceId: "OLDDEVICE",
			startupVerificationDeviceId: "OLDDEVICE",
		});
		expectCanonicalRootForNewDevice(stateDir);
	});

	it("does not reuse a populated sibling storage root with ambiguous device metadata", () => {
		const stateDir = setupStateDir();
		seedExistingStorageRoot({
			accessToken: "secret-token-old",
		});
		expectCanonicalRootForNewDevice(stateDir);
	});
});
