import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { EvalFlags, Intrinsics, JSException, QuickJS } from "quickjs-wasi";
//#region src/agents/code-mode.worker.ts
var CodeModeWorkerFailure = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.name = "CodeModeWorkerFailure";
		this.code = code;
	}
};
var CodeModeGuestError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "CodeModeGuestError";
	}
};
function isQuickJsInterruptedError(error) {
	if (error instanceof CodeModeGuestError) return false;
	return errorMessage(error) === "interrupted";
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function toJsonSafe(value) {
	if (value === void 0) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		if (value instanceof Error) return {
			name: value.name,
			message: value.message
		};
		if (value === null) return null;
		switch (typeof value) {
			case "string":
			case "number":
			case "boolean": return value;
			case "bigint":
			case "symbol":
			case "function": return String(value);
			default: return Object.prototype.toString.call(value);
		}
	}
}
function errorMessage(error) {
	if (error instanceof JSException) return error.stack || error.message || String(error);
	if (error instanceof Error) return error.message || String(error);
	return String(error);
}
const CONTROLLER_SOURCE = String.raw`
(() => {
  const output = [];
  const pending = new Map();
  const catalog = Array.isArray(globalThis.__openclawCatalog) ? globalThis.__openclawCatalog : [];

  function safe(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      if (value instanceof Error) {
        return { name: value.name, message: value.message };
      }
      if (value === null) return null;
      const type = typeof value;
      if (type === "string" || type === "number" || type === "boolean") return value;
      return String(value);
    }
  }

  function asText(value) {
    if (typeof value === "string") return value;
    const encoded = JSON.stringify(safe(value));
    return typeof encoded === "string" ? encoded : String(value);
  }

  function request(method, args) {
    const id = String(globalThis.__openclawHostRequest(String(method), JSON.stringify(safe(args ?? []))));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function settle(id, ok, payload) {
    const entry = pending.get(String(id));
    if (!entry) return false;
    pending.delete(String(id));
    let parsed = null;
    try {
      parsed = JSON.parse(String(payload));
    } catch {
      parsed = String(payload);
    }
    if (ok) {
      entry.resolve(parsed);
    } else {
      const error = new Error(typeof parsed === "string" ? parsed : parsed?.message ?? "nested tool failed");
      entry.reject(error);
    }
    return true;
  }

  const baseTools = Object.create(null);
  Object.defineProperties(baseTools, {
    search: { value: (query, options) => request("search", [query, options]), enumerable: true },
    describe: { value: (id) => request("describe", [id]), enumerable: true },
    call: { value: (id, input) => request("call", [id, input]), enumerable: true },
  });

  const safeNameCounts = new Map();
  for (const tool of catalog) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
    safeNameCounts.set(name, (safeNameCounts.get(name) ?? 0) + 1);
  }
  for (const tool of catalog) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    const id = typeof tool?.id === "string" ? tool.id : "";
    if (!id || safeNameCounts.get(name) !== 1 || Object.prototype.hasOwnProperty.call(baseTools, name)) {
      continue;
    }
    Object.defineProperty(baseTools, name, {
      value: (input) => request("call", [id, input]),
      enumerable: true,
    });
  }

  Object.defineProperties(globalThis, {
    ALL_TOOLS: { value: Object.freeze(catalog.slice()), enumerable: true },
    tools: { value: Object.freeze(baseTools), enumerable: true },
    text: { value: (value) => output.push({ type: "text", text: asText(value) }), enumerable: true },
    json: { value: (value) => output.push({ type: "json", value: safe(value) }), enumerable: true },
    yield_control: { value: (reason) => request("yield", [reason]), enumerable: true },
    __openclawSettleBridge: { value: settle },
    __openclawTakeOutput: { value: () => output.splice(0) },
  });
})();
`;
function buildUserSource(code) {
	return `globalThis.__openclawResult = (async () => {\n${code}\n})()`;
}
function createHostRequestHandler(params) {
	return (methodHandle, argsHandle) => {
		if (params.pendingRequests.length >= params.config.maxPendingToolCalls) throw new Error("too many pending code mode tool calls");
		const method = methodHandle.toString();
		if (method !== "search" && method !== "describe" && method !== "call" && method !== "yield") throw new Error("unsupported code mode bridge method");
		let args = [];
		try {
			args = JSON.parse(argsHandle.toString());
		} catch {
			args = [];
		}
		const id = `bridge:${params.pendingRequests.length + 1}:${randomUUID()}`;
		params.pendingRequests.push({
			id,
			method,
			args: Array.isArray(args) ? args : []
		});
		return params.vm.newString(id);
	};
}
async function createVm(params) {
	const startedAt = Date.now();
	let timedOut = false;
	const vm = await QuickJS.create({
		memoryLimit: params.config.memoryLimitBytes,
		intrinsics: Intrinsics.ALL,
		timezoneOffset: 0,
		interruptHandler: () => {
			timedOut = Date.now() - startedAt > params.config.timeoutMs;
			return timedOut;
		}
	});
	const catalogHandle = vm.hostToHandle(params.catalog);
	try {
		vm.setProp(vm.global, "__openclawCatalog", catalogHandle);
	} finally {
		catalogHandle.dispose();
	}
	const hostRequest = vm.newFunction("__openclawHostRequest", createHostRequestHandler({
		vm,
		pendingRequests: params.pendingRequests,
		config: params.config
	}));
	try {
		vm.setProp(vm.global, "__openclawHostRequest", hostRequest);
	} finally {
		hostRequest.dispose();
	}
	vm.evalCode(CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
	return {
		vm,
		didTimeout: () => timedOut
	};
}
async function restoreVm(params) {
	const startedAt = Date.now();
	let timedOut = false;
	const snapshot = QuickJS.deserializeSnapshot(params.snapshotBytes);
	const vm = await QuickJS.restore(snapshot, {
		memoryLimit: params.config.memoryLimitBytes,
		intrinsics: Intrinsics.ALL,
		timezoneOffset: 0,
		interruptHandler: () => {
			timedOut = Date.now() - startedAt > params.config.timeoutMs;
			return timedOut;
		}
	});
	vm.registerHostCallback("__openclawHostRequest", createHostRequestHandler({
		vm,
		pendingRequests: params.pendingRequests,
		config: params.config
	}));
	return {
		vm,
		didTimeout: () => timedOut
	};
}
function takeOutput(vm) {
	const take = vm.global.getProp("__openclawTakeOutput");
	try {
		const output = vm.callFunction(take, vm.undefined);
		try {
			const dumped = vm.dump(output);
			return Array.isArray(dumped) ? dumped : [];
		} finally {
			output.dispose();
		}
	} finally {
		take.dispose();
	}
}
function drainPendingJobs(vm) {
	for (let index = 0; index < 1e3; index += 1) if (vm.executePendingJobs() === 0) return;
	throw new Error("code mode pending job limit exceeded");
}
function getResultHandle(vm) {
	return vm.global.getProp("__openclawResult");
}
async function readCompletedResult(vm, resultHandle) {
	if (!resultHandle.isPromise) return toJsonSafe(vm.dump(resultHandle));
	const settled = await vm.resolvePromise(resultHandle);
	if ("error" in settled) try {
		throw new CodeModeGuestError(errorMessage(vm.dump(settled.error)));
	} finally {
		settled.error.dispose();
	}
	try {
		return toJsonSafe(vm.dump(settled.value));
	} finally {
		settled.value.dispose();
	}
}
function waitingResult(params) {
	const snapshotBytes = QuickJS.serializeSnapshot(params.vm.snapshot());
	if (snapshotBytes.byteLength > params.config.maxSnapshotBytes) throw new Error("code mode snapshot limit exceeded");
	return {
		status: "waiting",
		snapshotBytes,
		pendingRequests: params.pendingRequests,
		output: params.output
	};
}
async function runExec(input) {
	const pendingRequests = [];
	const { vm, didTimeout } = await createVm({
		catalog: input.catalog,
		config: input.config,
		pendingRequests
	});
	try {
		vm.evalCode(buildUserSource(input.source), "openclaw-code-mode:user.js", EvalFlags.ASYNC).dispose();
		drainPendingJobs(vm);
		const output = takeOutput(vm);
		const resultHandle = getResultHandle(vm);
		try {
			if (pendingRequests.length > 0) return waitingResult({
				vm,
				pendingRequests,
				output,
				config: input.config
			});
			if (resultHandle.isPromise && resultHandle.promiseState === 0) throw new Error("code mode promise is pending without host work");
			return {
				status: "completed",
				value: await readCompletedResult(vm, resultHandle),
				output
			};
		} finally {
			resultHandle.dispose();
		}
	} catch (error) {
		if (didTimeout() || isQuickJsInterruptedError(error)) throw new CodeModeWorkerFailure("timeout", "code mode timeout exceeded", { cause: error });
		throw error;
	} finally {
		vm.dispose();
	}
}
async function runResume(input) {
	const pendingRequests = [];
	const { vm, didTimeout } = await restoreVm({
		snapshotBytes: input.snapshotBytes,
		config: input.config,
		pendingRequests
	});
	try {
		const settle = vm.global.getProp("__openclawSettleBridge");
		try {
			for (const request of input.settledRequests) {
				const id = vm.newString(request.id);
				const payload = vm.newString(JSON.stringify(request.ok ? request.value : request.error));
				try {
					vm.callFunction(settle, vm.undefined, id, request.ok ? vm.true : vm.false, payload).dispose();
				} finally {
					id.dispose();
					payload.dispose();
				}
			}
		} finally {
			settle.dispose();
		}
		drainPendingJobs(vm);
		const output = takeOutput(vm);
		const resultHandle = getResultHandle(vm);
		try {
			if (pendingRequests.length > 0) return waitingResult({
				vm,
				pendingRequests,
				output,
				config: input.config
			});
			if (resultHandle.isPromise && resultHandle.promiseState === 0) throw new Error("code mode promise is pending without host work");
			return {
				status: "completed",
				value: await readCompletedResult(vm, resultHandle),
				output
			};
		} finally {
			resultHandle.dispose();
		}
	} catch (error) {
		if (didTimeout() || isQuickJsInterruptedError(error)) throw new CodeModeWorkerFailure("timeout", "code mode timeout exceeded", { cause: error });
		throw error;
	} finally {
		vm.dispose();
	}
}
async function main() {
	const input = workerData;
	if (!isRecord(input) || !isRecord(input.config)) return {
		status: "failed",
		error: "invalid code mode worker input",
		code: "invalid_input",
		output: []
	};
	try {
		if (input.kind === "exec" && typeof input.source === "string") return await runExec({
			kind: "exec",
			source: input.source,
			config: input.config,
			catalog: Array.isArray(input.catalog) ? input.catalog : []
		});
		if (input.kind === "resume" && input.snapshotBytes instanceof Uint8Array) return await runResume({
			kind: "resume",
			snapshotBytes: input.snapshotBytes,
			config: input.config,
			settledRequests: Array.isArray(input.settledRequests) ? input.settledRequests : []
		});
		return {
			status: "failed",
			error: "invalid code mode worker input",
			code: "invalid_input",
			output: []
		};
	} catch (error) {
		return {
			status: "failed",
			error: errorMessage(error),
			code: error instanceof CodeModeWorkerFailure ? error.code : "internal_error",
			output: []
		};
	}
}
parentPort?.postMessage(await main());
//#endregion
export {};
