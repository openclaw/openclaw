import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	MemorySearchConfig,
	OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

const { watchMock } = vi.hoisted(() => ({
	watchMock: vi.fn(() => ({
		on: vi.fn(),
		close: vi.fn(async () => undefined),
	})),
}));

vi.mock("chokidar", () => ({
	default: { watch: watchMock },
	watch: watchMock,
}));

vi.mock("./sqlite-vec.js", () => ({
	loadSqliteVecExtension: async () => ({
		ok: false,
		error: "sqlite-vec disabled in tests",
	}),
}));

vi.mock("./embeddings.js", () => ({
	createEmbeddingProvider: async () => ({
		requestedProvider: "openai",
		provider: {
			id: "mock",
			model: "mock-embed",
			embedQuery: async () => [1, 0],
			embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
		},
	}),
}));

type MemoryIndexModule = typeof import("./index.js");
type MemoryEmbeddingProvidersModule =
	typeof import("../../../../src/plugins/memory-embedding-providers.js");

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];
let clearRegistry: MemoryEmbeddingProvidersModule["clearMemoryEmbeddingProviders"];
let registerAdapter: MemoryEmbeddingProvidersModule["registerMemoryEmbeddingProvider"];

describe("memory watcher config", () => {
	let manager: MemoryIndexManager | null = null;
	let workspaceDir = "";
	let extraDir = "";

	beforeEach(async () => {
		vi.resetModules();
		({ getMemorySearchManager, closeAllMemorySearchManagers } = await import(
			"./index.js"
		));
		({
			clearMemoryEmbeddingProviders: clearRegistry,
			registerMemoryEmbeddingProvider: registerAdapter,
		} = await import("../../../../src/plugins/memory-embedding-providers.js"));
		vi.clearAllMocks();
		clearRegistry();
		registerBuiltInMemoryEmbeddingProviders({
			registerMemoryEmbeddingProvider: registerAdapter,
		});
	});

	afterEach(async () => {
		watchMock.mockClear();
		if (manager) {
			await manager.close();
			manager = null;
		}
		await closeAllMemorySearchManagers();
		clearRegistry();
		if (workspaceDir) {
			await fs.rm(workspaceDir, { recursive: true, force: true });
			workspaceDir = "";
			extraDir = "";
		}
	});

	async function setupWatcherWorkspace(seedFile: {
		name: string;
		contents: string;
	}) {
		workspaceDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "openclaw-memory-watch-"),
		);
		extraDir = path.join(workspaceDir, "extra");
		await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
		await fs.mkdir(extraDir, { recursive: true });
		await fs.writeFile(path.join(extraDir, seedFile.name), seedFile.contents);
	}

	function createWatcherConfig(
		overrides?: Partial<MemorySearchConfig>,
	): OpenClawConfig {
		const defaults: NonNullable<
			NonNullable<OpenClawConfig["agents"]>["defaults"]
		> = {
			workspace: workspaceDir,
			memorySearch: {
				provider: "openai",
				model: "mock-embed",
				store: {
					path: path.join(workspaceDir, "index.sqlite"),
					vector: { enabled: false },
				},
				sync: {
					watch: true,
					watchDebounceMs: 25,
					onSessionStart: false,
					onSearch: false,
				},
				query: { minScore: 0, hybrid: { enabled: false } },
				extraPaths: [extraDir],
				...overrides,
			},
		};
		return {
			agents: {
				defaults,
				list: [{ id: "main", default: true }],
			},
		} as OpenClawConfig;
	}

	async function expectWatcherManager(cfg: OpenClawConfig) {
		const result = await getMemorySearchManager({ cfg, agentId: "main" });
		expect(result.manager).not.toBeNull();
		if (!result.manager) {
			throw new Error("manager missing");
		}
		manager = result.manager as unknown as MemoryIndexManager;
	}

	it("watches markdown globs and ignores dependency directories", async () => {
		await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
		const cfg = createWatcherConfig();

		await expectWatcherManager(cfg);

		expect(watchMock).toHaveBeenCalledTimes(1);
		const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
			string[],
			Record<string, unknown>,
		];
		expect(watchedPaths).toEqual(
			expect.arrayContaining([
				path.join(workspaceDir, "MEMORY.md"),
				path.join(workspaceDir, "memory.md"),
				path.join(workspaceDir, "memory", "**", "*.md"),
				path.join(extraDir, "**", "*.md"),
			]),
		);
		expect(options.ignoreInitial).toBe(true);
		expect(options.awaitWriteFinish).toEqual({
			stabilityThreshold: 25,
			pollInterval: 100,
		});

		const ignored = options.ignored as
			| ((watchPath: string) => boolean)
			| undefined;
		expect(ignored).toBeTypeOf("function");
		expect(
			ignored?.(
				path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"),
			),
		).toBe(true);
		expect(
			ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md")),
		).toBe(true);
		expect(
			ignored?.(path.join(workspaceDir, "memory", "project", "notes.md")),
		).toBe(false);
	});

	it("watches multimodal extensions with case-insensitive globs", async () => {
		await setupWatcherWorkspace({ name: "PHOTO.PNG", contents: "png" });
		const cfg = createWatcherConfig({
			provider: "gemini",
			model: "gemini-embedding-2-preview",
			fallback: "none",
			multimodal: { enabled: true, modalities: ["image", "audio"] },
		});

		await expectWatcherManager(cfg);

		expect(watchMock).toHaveBeenCalledTimes(1);
		const [watchedPaths] = watchMock.mock.calls[0] as unknown as [
			string[],
			Record<string, unknown>,
		];
		expect(watchedPaths).toEqual(
			expect.arrayContaining([
				path.join(extraDir, "**", "*.[pP][nN][gG]"),
				path.join(extraDir, "**", "*.[wW][aA][vV]"),
			]),
		);
	});
});
