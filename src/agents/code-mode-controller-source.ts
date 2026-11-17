/** Guest globals and host bridge shared by Code Mode JavaScript executors. */
import { MAX_CODE_MODE_PENDING_TOOL_CALLS } from "./code-mode-worker-types.js";

/** Console is guest-only diagnostic text, not a host logging capability. */
export const CODE_MODE_CONTROLLER_SOURCE = String.raw`
(() => {
  const output = [];
  const pending = new Map();
  const queued = new Map();
  // Only ordinary requests use this quota. Swarm retains its group/VM bounds
  // while sharing the same ordered queue and in-flight slots.
  const maxQueuedOrdinary = ${MAX_CODE_MODE_PENDING_TOOL_CALLS};
  let queuedOrdinaryCount = 0;
  let admissionError;
  const maxPending = globalThis.__openclawMaxPendingToolCalls;
  delete globalThis.__openclawMaxPendingToolCalls;
  const catalogBindings = Array.isArray(globalThis.__openclawCatalog) ? globalThis.__openclawCatalog : [];
  const apiFiles = Array.isArray(globalThis.__openclawApiFiles) ? globalThis.__openclawApiFiles : [];
  const namespaceDescriptors = Array.isArray(globalThis.__openclawNamespaces) ? globalThis.__openclawNamespaces : [];
  const hostRequest = globalThis.__openclawHostRequest;
  const hostCancelRequest = globalThis.__openclawHostCancelRequest;
  const hostTakeBridgeReply = globalThis.__openclawHostTakeBridgeReply;
  const hostObserveNetworkContent = globalThis.__openclawHostObserveNetworkContent;
  const hostOutput = globalThis.__openclawHostOutput;
  delete globalThis.__openclawHostOutput;
  delete globalThis.__openclawHostObserveNetworkContent;
  delete globalThis.__openclawHostRequest;
  delete globalThis.__openclawHostCancelRequest;
  delete globalThis.__openclawHostTakeBridgeReply;
  delete globalThis.__openclawCatalog;
  delete globalThis.__openclawApiFiles;
  delete globalThis.__openclawNamespaces;
  const bridgeSequences = new Map();
  const timers = new Map();
  // Keep rejection ownership in the snapshot so a handler attached after wait
  // can clear it; an unawaited failure must not become a successful cell.
  const unhandledRejections = new Set();
  // Rejection callbacks cross the VM boundary. Guest prototype changes must not
  // make them throw into the dependency's eager, uncapped exception formatter.
  const addUnhandledRejection = unhandledRejections.add.bind(unhandledRejections);
  const deleteUnhandledRejection = unhandledRejections.delete.bind(unhandledRejections);
  const unhandledRejectionValues = unhandledRejections.values.bind(unhandledRejections);
  const nextUnhandledRejection = Function.prototype.call.bind(unhandledRejections.values().next);
  // Maps each host-rejected bridge error to its terminal failure code. Guest
  // writes to error.code never reach the cell result; only this record does.
  const bridgeErrors = new WeakMap();
  // Guest prototype changes must not replace the operations that own error provenance.
  const rememberBridgeError = bridgeErrors.set.bind(bridgeErrors);
  const bridgeFailureCode = bridgeErrors.get.bind(bridgeErrors);
  let nextTimerId = 0;
  const GuestPromise = Promise;
  const GuestError = Error;
  const GuestTypeError = TypeError;
  const GuestRangeError = RangeError;
  const stringifyJson = JSON.stringify;
  const string = String;
  const sliceString = Function.prototype.call.bind(String.prototype.slice);
  const maxErrorUnits = Math.min(globalThis.__openclawMaxOutputBytes ?? 16_384, 16_384);
  delete globalThis.__openclawMaxOutputBytes;
  // Bridge payloads carry trusted failure codes; guest JSON replacements must not rewrite them.
  const parseJson = JSON.parse;
  function encodeError(error) {
    // Recover provenance before diagnostic getters can fail. Only bounded primitive
    // strings cross to the host; thrown arrays/objects must never be recursively dumped.
    const bridgeCode = bridgeFailureCode(error) ?? null;
    const diagnostic = (read, fallback) => {
      try {
        const value = read();
        const text = value !== null && (typeof value === "object" || typeof value === "function")
          ? "[Thrown object]" : string(value);
        return text.length <= maxErrorUnits ? text
          : sliceString(text, 0, maxErrorUnits) + " [error truncated]";
      } catch { return fallback; }
    };
    return stringifyJson({
      __proto__: null,
      bridgeCode,
      name: diagnostic(() => error?.name ?? "Error", "Error"),
      message: diagnostic(() => error?.message ?? error, "Error"),
      stack: diagnostic(() => {
        const stack = error?.stack;
        return typeof stack === "string" ? stack : "";
      }, ""),
    });
  }
  function emitOutput(entry) {
    if (hostOutput) return hostOutput(encodeFinalValue(entry));
    return output.push(entry);
  }
  const promiseOutput = "[Unawaited Promise: use await or Promise.all(...) before emitting or returning values.]";
  let networkContentObserved = false;
  function observeNetworkContent() {
    if (networkContentObserved) return;
    networkContentObserved = true;
    hostObserveNetworkContent();
  }

  
  // The counter lives in the VM snapshot. JSON code units are a conservative
  // bound (at most three UTF-8 bytes each), including empty-message overhead.
  let consoleUnits = 0;
  const consoleLimit = 16_384;
  const consoleMarker = "[console output truncated]";
  function consoleWrite(level, args) {
    if (consoleUnits >= consoleLimit) return;
    let nodes = 100;
    const seen = new Set();
    const clip = (value, limit) => {
      if (value.length <= limit) return value;
      // Do not split a surrogate pair at a diagnostic boundary.
      let end = limit;
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      return value.slice(0, end) + "…[truncated]";
    };
    const inspect = (value, depth = 0) => {
      if (--nodes < 0) return "[truncated]";
      if (typeof value === "string") return clip(value, 512);
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value === "undefined") return "undefined";
      if (typeof value === "bigint") return clip(String(value), 512) + "n";
      if (typeof value === "symbol") return clip(String(value), 512);
      if (typeof value === "function") return "[Function]";
      if (seen.has(value)) return "[Circular]";
      if (depth >= 4) return "[truncated]";
      seen.add(value);
      try {
        if (value instanceof GuestPromise) return promiseOutput;
        const array = Array.isArray(value);
        const result = array ? [] : Object.create(null);
        let count = 0;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (count++ >= 50 || nodes <= 0) {
            if (array) result.push("[truncated]");
            else result["…"] = "[truncated]";
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          const item = descriptor && "value" in descriptor
            ? inspect(descriptor.value, depth + 1) : "[Accessor]";
          if (array) result.push(item);
          else result[clip(key, 512)] = item;
        }
        if (value instanceof Error) {
          const message = Object.getOwnPropertyDescriptor(value, "message");
          result.message = message && "value" in message ? inspect(message.value, depth + 1) : "[Accessor]";
        }
        return result;
      } finally {
        seen.delete(value);
      }
    };
    let message = level === "log" ? "" : "[" + level + "] ";
    for (let i = 0; i < args.length; i++) {
      if (i > 0) message += " ";
      if (nodes <= 0 || message.length >= 4096) { message += "[truncated]"; break; }
      try {
        const value = inspect(args[i]);
        message += typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        message += "[Unserializable]";
      }
    }
    const entry = { type: "text", text: clip(message, 4096) };
    const units = JSON.stringify(entry).length;
    if (consoleUnits + units > consoleLimit - 100) {
      emitOutput({ type: "text", text: consoleMarker });
      consoleUnits = consoleLimit;
      return;
    }
    consoleUnits += units;
    emitOutput(entry);
  }
  const guestConsole = Object.freeze(Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => consoleWrite(level, args)]),
  ));


  function safe(value, diagnosePromises = false) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(diagnosePromises ? serializeOutputValue(value) : value));
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
    const encoded = JSON.stringify(safe(value, true));
    return typeof encoded === "string" ? encoded : String(value);
  }

  function assertQueueCapacity(queue) {
    if (!admissionError && !queue && pending.size >= maxPending && queuedOrdinaryCount >= maxQueuedOrdinary) {
      admissionError = "code mode bridge queue limit exceeded (" + maxQueuedOrdinary + " ordinary requests queued; " + maxPending + " in-flight slots). Await smaller batches before creating more tool calls or timers.";
    }
    // Sticky even if guest code catches the immediate error: the worker refuses
    // this entire synchronous frontier before dispatching any admitted prefix.
    if (admissionError) throw new Error(admissionError);
  }

  function beginRequest(method, args, { queue = false } = {}) {
    assertQueueCapacity(queue);
    const methodName = String(method);
    const sequence = (bridgeSequences.get(methodName) ?? 0) + 1;
    bridgeSequences.set(methodName, sequence);
    const id = "bridge:" + methodName + ":" + String(sequence);
    const argsJson = stringifyJson(args ?? []);
    // Guest toJSON/getters can create requests while serializing this input.
    assertQueueCapacity(queue);
    const callStack = new GuestError().stack;
    let callbacks;
    const promise = new Promise((resolve, reject) => { callbacks = { resolve, reject }; });
    const admit = () => {
      callbacks.stack = callStack;
      callbacks.location = hostRequest(methodName, argsJson, id, callStack);
      pending.set(id, callbacks);
    };
    if (queue || pending.size >= maxPending) {
      queued.set(id, { admit, callbacks, ordinary: !queue });
      if (!queue) queuedOrdinaryCount++;
    } else admit();
    return { id, promise };
  }

  // Admission and cancellation release capacity through the same owner.
  function takeQueuedRequest(id) {
    const entry = queued.get(id);
    if (!entry) return;
    queued.delete(id);
    if (entry.ordinary) queuedOrdinaryCount--;
    return entry;
  }

  // Refill after guest continuations run so dependent ordinary calls retain
  // first use of released slots. Waiting requests refill in insertion order.
  // Closures, copied inputs, and stable IDs live only in the bounded VM snapshot.
  function drainQueuedRequests() {
    while (queued.size > 0 && pending.size < maxPending) {
      const id = queued.keys().next().value;
      takeQueuedRequest(id).admit();
    }
  }

  function request(method, args, options) {
    return beginRequest(method, args, options).promise;
  }

  function scheduleTimer(callback, delay, args) {
    if (typeof callback !== "function") {
      throw new TypeError("setTimeout callback must be a function");
    }
    const numericDelay = Number(delay);
    const delayMs = Number.isFinite(numericDelay) ? Math.max(0, Math.floor(numericDelay)) : 0;
    const timerId = ++nextTimerId;
    const timerRequest = beginRequest("sleep", [delayMs]);
    timers.set(timerId, timerRequest.id);
    void timerRequest.promise.then(() => {
      if (!timers.delete(timerId)) return;
      callback(...args);
    });
    return timerId;
  }

  function cancelTimer(timerId) {
    const requestId = timers.get(Number(timerId));
    if (!requestId) return;
    timers.delete(Number(timerId));
    const queuedEntry = takeQueuedRequest(requestId);
    if (queuedEntry) {
      queuedEntry.callbacks.resolve(null);
      return;
    }
    hostCancelRequest(requestId);
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.resolve(null);
  }


  class SwarmAgentError extends Error {
    constructor(runId, status, detail) {
      super("Swarm agent " + runId + " " + status + ": " + detail);
      this.name = "SwarmAgentError";
      this.runId = runId;
      this.status = status;
    }
  }

  function swarmNote(kind, value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(kind + " note must be a non-empty string");
    }
    void request("swarmNote", [{ kind, text: value }], { queue: true }).catch(() => {});
  }

  async function runAgent(prompt, options = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("agents.run prompt must be a non-empty string");
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("agents.run options must be an object");
    }
    if (options.phase !== undefined && (typeof options.phase !== "string" || !options.phase.trim())) {
      throw new TypeError("agents.run phase must be a non-empty string");
    }
    // Match the submitted contract even when callers reuse options while the child runs.
    const structured = options.schema !== undefined;
    if (options.phase !== undefined) swarmNote("phase", options.phase);
    const spawned = await request("agentSpawn", [prompt, options], { queue: true });
    const completion = await request("agentWait", [spawned.runId], { queue: true });
    if (!completion || completion.status !== "done") {
      const runId = completion?.runId ?? spawned.runId ?? "unknown";
      const status = completion?.status ?? "failed";
      const detail = [completion?.error, completion?.schemaError, completion?.result].find(
        (value) => typeof value === "string" && value.trim()
      ) || "collector returned no result";
      throw new SwarmAgentError(runId, status, detail);
    }
    return structured ? completion.structured : completion.result;
  }


  function namespaceFunction(namespaceId, path) {
    const callablePath = Object.freeze((Array.isArray(path) ? path : []).map((entry) => String(entry)));
    return (...args) => request("namespace", [namespaceId, callablePath, args]);
  }

  function deserializeNamespaceValue(namespaceId, value) {
    if (!value || typeof value !== "object") return null;
    if (value.kind === "function") {
      return namespaceFunction(namespaceId, Array.isArray(value.path) ? value.path.slice() : []);
    }
    if (value.kind === "array") {
      return Object.freeze((Array.isArray(value.items) ? value.items : []).map((item) => deserializeNamespaceValue(namespaceId, item)));
    }
    if (value.kind === "object") {
      const object = Object.create(null);
      for (const entry of Array.isArray(value.entries) ? value.entries : []) {
        const key = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
        if (!key) continue;
        const projected = deserializeNamespaceValue(namespaceId, entry[1]);
        Object.defineProperty(object, key, namespaceId === "mcp" && entry[1]?.kind === "value"
          ? { get: () => { observeNetworkContent(); return projected; }, enumerable: true }
          : { value: projected, enumerable: true });
      }
      return Object.freeze(object);
    }
    // Producers normalize these guest-owned values; a second JSON copy can OOM into safe()'s text fallback.
    return value.value;
  }

  function settle(id, ok, payload) {
    const entry = pending.get(String(id));
    if (!entry) return false;
    // Host replies are encoded JSON. Decoding failure must terminate the cell;
    // resolving raw transport text would silently change the tool result's type.
    const parsed = parseJson(payload);
    pending.delete(String(id));
    if (ok) {
      entry.resolve(parsed);
    } else {
      const error = new GuestError(typeof parsed === "string" ? parsed : parsed?.message ?? "nested tool failed");
      if (entry.stack) Object.defineProperty(error, "stack", { value: entry.stack, writable: true, configurable: true });
      if (entry.location) error.location = entry.location;
      const code = parsed && typeof parsed === "object" ? parsed.code : undefined;
      if (parsed && typeof parsed === "object") {
        error.code = code;
        error.effectStatus = "unknown";
      }
      rememberBridgeError(
        error,
        code === "invalid_input" || code === "input_contract" || code === "store_range" || code === "store_type"
          ? "invalid_input" : "internal_error",
      );
      entry.reject(error);
    }
    return true;
  }

  function settleHostReplies() {
    // Reply data comes only from the host, so guest calls cannot forge settlement or provenance.
    for (;;) {
      const reply = hostTakeBridgeReply();
      if (reply === undefined || reply === null) return;
      settle(reply.id, reply.ok === true, reply.json);
    }
  }

  function nodeHandle(descriptor) {
    const handle = Object.create(null);
    Object.defineProperties(handle, {
      id: { value: descriptor.id, enumerable: true },
      name: { value: descriptor.name, enumerable: true },
      invoke: {
        value: (command, params) => request("nodes", ["invoke", descriptor.id, command, params]),
        enumerable: true,
      },
    });
    if (typeof descriptor.listDirCommand === "string") {
      Object.defineProperty(handle, "listDir", {
        value: (path) => request("nodes", ["invoke", descriptor.id, descriptor.listDirCommand, { path }]),
        enumerable: true,
      });
    }
    return Object.freeze(handle);
  }

  const nodes = Object.freeze({
    list: () => request("nodes", ["list"]),
    get: async (idOrName) => nodeHandle(await request("nodes", ["get", idOrName])),
  });

  const skills = Object.freeze({
    list: (offset = 0) => request("skillsList", [offset]),
    search: (query, limit) => request("skillsSearch", limit === undefined ? [query] : [query, limit]),
    read: (name) => request("skillsRead", [name]),
  });

  const results = Object.freeze({
    save: (value) => request("resultSave", [value]),
    load: (id) => request("resultLoad", [id]),
    delete: (id) => request("resultDelete", [id]),
  });

  // Session operations use the existing result bridge; buffers stay with the host cell.
  async function sessionResult(method, key, value) {
    if (typeof key !== "string") throw new GuestTypeError("Code Mode store key must be a string.");
    try {
      const result = await request(method, method === "resultSave"
        ? [value, "session", key]
        : [key, "session"]);
      return method === "resultLoad" ? result.value : undefined;
    } catch (error) {
      if (!(error instanceof GuestError)) throw error;
      const Constructor = error.code === "store_range" ? GuestRangeError
        : error.code === "store_type" ? GuestTypeError : undefined;
      if (!Constructor) throw error;
      const typed = new Constructor(error.message);
      typed.code = error.code;
      typed.stack = error.stack;
      const bridgeCode = bridgeFailureCode(error);
      if (bridgeCode) rememberBridgeError(typed, bridgeCode);
      throw typed;
    }
  }

  if (globalThis.__openclawSwarmEnabled === true) {
    Object.defineProperties(globalThis, {
      agents: {
        value: Object.freeze({ run: runAgent }),
        enumerable: true,
      },
      phase: { value: (title) => swarmNote("phase", title), enumerable: true },
      log: { value: (message) => swarmNote("log", message), enumerable: true },
    });
  }

  function normalizeApiPath(value) {
    const text = String(value ?? "").trim().replace(/^\/+/, "");
    if (!text || text.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("invalid API file path");
    }
    return text;
  }

  const apiFileMap = new Map();
  for (const file of apiFiles) {
    if (!file || typeof file !== "object") continue;
    const path = typeof file.path === "string" ? file.path : "";
    const content = typeof file.content === "string" ? file.content : "";
    if (!path || !content) continue;
    apiFileMap.set(path, Object.freeze({
      path,
      content,
      description: typeof file.description === "string" ? file.description : undefined,
      bytes: file.bytes,
    }));
  }
  // Native declarations are generated by describe only when read, not injected
  // for every tool into every VM. Listing needs only the bounded callable metadata.
  const nativeApiFiles = new Map(catalogBindings.map(binding => [
    "tools/" + binding.callableName + ".d.ts", binding.callableName,
  ]));
  const api = Object.freeze({
    list: async (prefix = "") => {
      // list takes a directory prefix, so tolerate a trailing slash (API.list("mcp/"))
      // that read's exact-path normalizer would otherwise reject as an empty segment.
      const rawPrefix = prefix == null ? "" : String(prefix).trim().replace(/\/+$/, "");
      const normalizedPrefix = rawPrefix === "" ? "" : normalizeApiPath(rawPrefix);
      const files = [...apiFileMap.values(), ...[...nativeApiFiles.keys()].map(path => ({ path }))]
        .filter((file) => !normalizedPrefix || file.path === normalizedPrefix || file.path.startsWith(normalizedPrefix.replace(/\/?$/, "/")))
        .map((file) => Object.freeze({
          path: file.path,
          description: file.description,
          bytes: file.bytes,
        }));
      if (files.some(file => file.path.startsWith("mcp/"))) observeNetworkContent();
      return { files };
    },
    read: async (path) => {
      const normalizedPath = normalizeApiPath(path);
      const file = apiFileMap.get(normalizedPath);
      if (file) {
        if (normalizedPath.startsWith("mcp/")) observeNetworkContent();
        return file;
      }
      const callableName = nativeApiFiles.get(normalizedPath);
      if (callableName) return request("describe", [callableName, "declaration"]);
      throw new Error("Unknown API file: " + normalizedPath);
    },
  });

  const callableHandles = new Map();
  const callableMetadata = new WeakMap();
  function callableHandle(binding) {
    const callableName = typeof binding?.callableName === "string" ? binding.callableName : "";
    if (!callableName) return null;
    const existing = callableHandles.get(callableName);
    if (existing) return existing;
    const isMcp = binding.source === "mcp";
    const path = isMcp ? Object.freeze(binding.path.slice()) : undefined;
    const handle = isMcp
      ? namespaceFunction(binding.namespaceId, path)
      : (input) => request("callValue", [callableName, input]);
    const metadata = Object.freeze({
      callableName,
      toolName: typeof binding.name === "string" ? binding.name : callableName,
      label: typeof binding.label === "string" ? binding.label : undefined,
      description: typeof binding.description === "string" ? binding.description : "",
      source: binding.source,
      input: binding.input,
      output: binding.output,
      ...(isMcp ? { apiPath: binding.apiPath } : {}),
      ...(isMcp && typeof binding.instructions === "string" ? { instructions: binding.instructions } : {}),
      ...(isMcp && typeof binding.instructionsHint === "string" ? { instructionsHint: binding.instructionsHint } : {}),
    });
    for (const [key, value] of Object.entries(metadata)) {
      Object.defineProperty(handle, key, binding.source !== "openclaw"
        ? { get: () => { observeNetworkContent(); return value; }, enumerable: true }
        : { value, enumerable: true });
    }
    Object.defineProperties(handle, {
      name: { value: callableName },
      describe: {
        value: isMcp
          ? () => request("namespace", [binding.namespaceId, [path[0], "$api"], [path.slice(1).join("."), { schema: true }]])
          : () => request("describe", [callableName]),
        enumerable: true,
      },
      toJSON: { value: () => {
        if (binding.source !== "openclaw") observeNetworkContent();
        return metadata;
      } },
    });
    const frozen = Object.freeze(handle);
    callableHandles.set(callableName, frozen);
    callableMetadata.set(frozen, metadata);
    return frozen;
  }
  // Project nested catalog handles before ordinary JSON conversion drops functions.
  function serializeOutputValue(value, seen = new Map(), finalState) {
    if (value instanceof GuestPromise) return promiseOutput;
    const metadata = callableMetadata.get(value);
    if (metadata) {
      if (metadata.source !== "openclaw") observeNetworkContent();
      return finalState ? serializeOutputValue(metadata, seen, finalState) : metadata;
    }
    if (finalState) {
      if (typeof value === "function") return undefined;
      if (typeof value === "bigint") finalState.hasBigInt = true;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    const proto = Object.getPrototypeOf(value);
    const isError = value instanceof Error;
    if (!finalState && !isError && !Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
    const plain = Array.isArray(value) ? new Array(value.length) : isError ? { name: value.name, message: value.message } : {};
    // Project before JSON.stringify can invoke Error.toJSON, and preserve graph
    // identity so cyclic custom fields use the ordinary bounded JSON fallback.
    seen.set(value, plain);
    if (finalState) {
      // Final conversion never invokes inherited toJSON hooks. Expanding sparse
      // arrays here keeps their allocation inside the guest's memory/time limits.
      Object.setPrototypeOf(plain, null);
      if (Array.isArray(value)) {
        for (let index = 0; index < plain.length; index++) {
          plain[index] = serializeOutputValue(value[index], seen, finalState);
        }
        return plain;
      }
      if (isError) {
        plain.name = serializeOutputValue(plain.name, seen, finalState);
        plain.message = serializeOutputValue(plain.message, seen, finalState);
      }
    }
    for (const key of Object.keys(value)) {
      if (isError && key === "toJSON") continue;
      Object.defineProperty(plain, key, {
        value: serializeOutputValue(value[key], seen, finalState), enumerable: true, configurable: true, writable: true,
      });
    }
    return plain;
  }

  function encodeFinalValue(value) {
    const state = { hasBigInt: false };
    const plain = serializeOutputValue(value, new Map(), state);
    if (typeof plain === "bigint") return stringifyJson("" + plain);
    const fallback = Array.isArray(plain) ? '"[object Array]"' : '"[object Object]"';
    // Detect BigInts before stringify can invoke a guest BigInt.toJSON hook.
    if (state.hasBigInt) return fallback;
    try {
      return stringifyJson(plain) ?? "null";
    } catch (error) {
      if (error instanceof GuestTypeError) return fallback;
      throw error;
    }
  }
  const catalog = Object.freeze({
    search: async (query, options) => {
      const matches = await request("search", [query, options]);
      return Object.freeze(matches.map((match) => {
        const handle = typeof match === "string" ? callableHandles.get(match) : callableHandle(match);
        if (!handle) throw new Error("Search result has no callable handle.");
        return handle;
      }));
    },
    all: () => Object.freeze(catalogBindings.map(binding => callableHandles.get(binding.callableName))),
  });

  const namespaceGlobals = Object.create(null);
  for (const descriptor of namespaceDescriptors) {
    const id = typeof descriptor?.id === "string" ? descriptor.id : "";
    const globalName = typeof descriptor?.globalName === "string" ? descriptor.globalName : "";
    if (!id || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) continue;
    const scope = deserializeNamespaceValue(id, descriptor.scope);
    Object.defineProperty(namespaceGlobals, globalName, {
      value: scope,
      enumerable: true,
    });
    const existingGlobal = Object.getOwnPropertyDescriptor(globalThis, globalName);
    if (existingGlobal && existingGlobal.configurable === false) continue;
    Object.defineProperty(globalThis, globalName, {
      value: scope,
      enumerable: true,
      configurable: true,
    });
  }

  for (const binding of catalogBindings) {
    const handle = callableHandle(binding);
    const callableName = typeof binding?.callableName === "string" ? binding.callableName : "";
    if (!handle || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callableName)) continue;
    Object.defineProperty(globalThis, callableName, {
      value: handle,
      enumerable: true,
      configurable: true,
    });
  }

  Object.defineProperties(globalThis, {
    API: { value: api, enumerable: true },
    catalog: { value: catalog, enumerable: true },
    nodes: { value: nodes, enumerable: true },
    namespaces: { value: Object.freeze(namespaceGlobals), enumerable: true },
    skills: { value: skills, enumerable: true },
    results: { value: results, enumerable: true },
    store: { value: (key, value) => sessionResult(value === undefined ? "resultDelete" : "resultSave", key, value), enumerable: true },
    load: { value: (key) => sessionResult("resultLoad", key), enumerable: true },
    setTimeout: { value: (callback, delay, ...args) => scheduleTimer(callback, delay, args), enumerable: true },
    clearTimeout: { value: cancelTimer, enumerable: true },
    console: { value: guestConsole, enumerable: true },
    text: { value: (value) => emitOutput({ type: "text", text: asText(value) }), enumerable: true },
    json: { value: (value) => emitOutput({ type: "json", value: safe(value, true) }), enumerable: true },
    yield_control: { value: (reason) => request("yield", [reason]), enumerable: true },
    __openclawSettleBridge: { value: settleHostReplies },
    __openclawBridgeFailureCode: { value: bridgeFailureCode },
    __openclawEncodeError: { value: encodeError },
    __openclawDrainQueuedRequests: { value: drainQueuedRequests },
    __openclawAdmissionError: { value: () => admissionError },
    // Final getters must run before the worker drains output and settles host work.
    __openclawRunCell: { value: async (run) => encodeFinalValue(await run()) },
    __openclawTakeOutputJson: { value: () => encodeFinalValue(output.splice(0)) },
    __openclawTrackRejection: {
      value: (promise, _reason, handled) => {
        if (handled) deleteUnhandledRejection(promise);
        else addUnhandledRejection(promise);
      },
    },
    __openclawUnhandledRejection: { value: () => nextUnhandledRejection(unhandledRejectionValues()).value },
  });
})();
`;
