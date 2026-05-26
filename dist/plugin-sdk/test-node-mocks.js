import { vi } from "vitest";
//#region src/plugin-sdk/test-helpers/node-builtin-mocks.ts
function resolveMockOverrides(actual, factory) {
	return typeof factory === "function" ? factory(actual) : factory;
}
function resolveDefaultBase(actual) {
	const defaultExport = actual.default;
	if (defaultExport && typeof defaultExport === "object") return defaultExport;
	return actual;
}
async function mockNodeBuiltinModule(loadActual, factory, options) {
	const actual = await loadActual();
	const overrides = resolveMockOverrides(actual, factory);
	const mocked = {
		...actual,
		...overrides
	};
	if (!options?.mirrorToDefault) return mocked;
	return {
		...mocked,
		default: {
			...resolveDefaultBase(actual),
			...overrides
		}
	};
}
async function mockNodeChildProcessSpawnSync(spawnSync) {
	return mockNodeBuiltinModule(() => import("node:child_process"), { spawnSync: (...args) => spawnSync(...args) });
}
async function mockNodeChildProcessExecFile(execFile) {
	return mockNodeBuiltinModule(() => import("node:child_process"), { execFile });
}
//#endregion
//#region src/test-utils/vitest-spies.ts
function restoreMocks(mocks) {
	for (const mock of mocks.toReversed()) mock.mockRestore();
}
function isPromiseLike(value) {
	return typeof value === "object" && value !== null && typeof value.finally === "function";
}
function withRestoredMocks(mocks, run) {
	try {
		const result = run();
		if (isPromiseLike(result)) return result.finally(() => restoreMocks(mocks));
		restoreMocks(mocks);
		return result;
	} catch (error) {
		restoreMocks(mocks);
		throw error;
	}
}
function mockProcessPlatform(platform) {
	return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}
function withMockedPlatform(platform, run) {
	return withRestoredMocks([mockProcessPlatform(platform)], run);
}
function withMockedWindowsPlatform(run) {
	return withMockedPlatform("win32", run);
}
//#endregion
export { mockNodeBuiltinModule, mockNodeChildProcessExecFile, mockNodeChildProcessSpawnSync, withMockedPlatform, withMockedWindowsPlatform, withRestoredMocks };
