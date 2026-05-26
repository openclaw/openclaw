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
export { mockNodeBuiltinModule, mockNodeChildProcessExecFile, mockNodeChildProcessSpawnSync };
