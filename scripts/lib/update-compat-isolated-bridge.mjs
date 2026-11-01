// Older updaters import recovery bridges into a process whose module cache still holds
// that release's dependency instances. Package activation keeps dependency paths, so
// linking current code there resolves cached older modules and can fail at link time.
// This file is copied into dist beside those bridges and may import only Node builtins:
// it runs the current export in a worker, whose module map loads one consistent tree.
import {
  isMainThread,
  MessageChannel,
  parentPort,
  receiveMessageOnPort,
  SHARE_ENV,
  Worker,
  workerData,
} from "node:worker_threads";

const MARK = "__openclawIsolatedCompat";

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function methodNames(value) {
  const names = new Set();
  for (
    let current = value;
    current && current !== Object.prototype && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (name !== "constructor" && typeof descriptor?.value === "function") {
        names.add(name);
      }
    }
  }
  return [...names];
}

function containsFunction(value, seen = new Set()) {
  if (typeof value === "function") {
    return true;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value).some((item) => containsFunction(item, seen));
}

/** Keeps live references on one side while the other side sees encoded values. */
function createCodec(side) {
  const local = new Map();
  const localIds = new WeakMap();
  const remoteIds = new WeakMap();
  const instanceCopies = new WeakSet();
  let next = 0;
  const register = (value) => {
    let id = localIds.get(value);
    if (id === undefined) {
      id = `${side}${next++}`;
      localIds.set(value, id);
      local.set(id, value);
    }
    return id;
  };
  const encodeError = (error) => {
    if (!(error instanceof Error)) {
      return { [MARK]: "thrown", value: encode(error) };
    }
    const props = {};
    for (const key of Object.keys(error)) {
      if (typeof error[key] !== "function") {
        props[key] = encode(error[key]);
      }
    }
    const remote = remoteIds.get(error);
    return {
      [MARK]: "error",
      ref: remote ?? register(error),
      remote: remote !== undefined,
      name: error.name,
      message: error.message,
      stack: error.stack,
      props,
    };
  };
  const encode = (value, seen = new Map()) => {
    if (value === process.env) {
      // Never write a stale copy back over the shared environment.
      return { ...value };
    }
    if (typeof value === "function") {
      return {
        [MARK]: "function",
        ref: remoteIds.get(value) ?? register(value),
        remote: remoteIds.has(value),
      };
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (value instanceof Error) {
      return encodeError(value);
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    const remote = remoteIds.get(value);
    if (instanceCopies.has(value)) {
      return { [MARK]: "instance", ref: remote, remote: true };
    }
    if (Array.isArray(value) || isPlainObject(value)) {
      const encoded = {
        [MARK]: Array.isArray(value) ? "array" : "object",
        ref: remote ?? register(value),
        remote: remote !== undefined,
        value: Array.isArray(value) ? [] : {},
      };
      seen.set(value, encoded);
      for (const [key, item] of Object.entries(value)) {
        encoded.value[key] = encode(item, seen);
      }
      return encoded;
    }
    if (value instanceof URL) {
      return { [MARK]: "url", href: value.href };
    }
    const methods = methodNames(value);
    if (methods.length === 0 || remote !== undefined) {
      // Data-only builtins (Date, Map, buffers) cross by structured clone.
      return remote !== undefined ? { [MARK]: "instance", ref: remote, remote: true } : value;
    }
    const data = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "function") {
        data[key] = encode(item, seen);
      }
    }
    return { [MARK]: "instance", ref: register(value), remote: false, methods, data };
  };
  const decode = (value, call, seen = new Map()) => {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => decode(item, call, seen));
    }
    const kind = value[MARK];
    if (kind === undefined) {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (kind === "url") {
      return new URL(value.href);
    }
    if (kind === "thrown") {
      return decode(value.value, call, seen);
    }
    if (kind === "error") {
      if (value.remote) {
        // Preserve the caller's own error object, including its class.
        return local.get(value.ref);
      }
      const error = new Error(value.message);
      error.name = value.name;
      error.stack = value.stack;
      for (const [key, item] of Object.entries(value.props)) {
        error[key] = decode(item, call, seen);
      }
      remoteIds.set(error, value.ref);
      return error;
    }
    if (value.remote) {
      // The other side returned one of our own live values; refresh mutable containers.
      const original = local.get(value.ref);
      // Frozen requester records and getter-only state stay as the caller left them.
      if ((Array.isArray(original) || isPlainObject(original)) && !Object.isFrozen(original)) {
        seen.set(value, original);
        const contents = Object.entries(value.value).map(([key, item]) => [
          key,
          decode(item, call, seen),
        ]);
        if (Array.isArray(original)) {
          if (Object.isExtensible(original)) {
            original.splice(0, original.length, ...contents.map(([, item]) => item));
          }
        } else {
          for (const key of Object.keys(original)) {
            if (!Object.hasOwn(value.value, key)) {
              Reflect.deleteProperty(original, key);
            }
          }
          for (const [key, item] of contents) {
            if (original[key] !== item) {
              Reflect.set(original, key, item);
            }
          }
        }
      }
      return original;
    }
    if (kind === "function") {
      const proxy = (...args) => call(value.ref, undefined, args);
      remoteIds.set(proxy, value.ref);
      return proxy;
    }
    if (kind === "object" || kind === "array") {
      const copy = kind === "array" ? [] : {};
      seen.set(value, copy);
      remoteIds.set(copy, value.ref);
      for (const [key, item] of Object.entries(value.value)) {
        copy[key] = decode(item, call, seen);
      }
      return copy;
    }
    if (kind === "instance") {
      const copy = {};
      seen.set(value, copy);
      remoteIds.set(copy, value.ref);
      instanceCopies.add(copy);
      for (const [key, item] of Object.entries(value.data)) {
        copy[key] = decode(item, call, seen);
      }
      for (const method of value.methods) {
        copy[method] = (...args) => call(value.ref, method, args);
      }
      return copy;
    }
    return value;
  };
  const invoke = (ref, method, args) => {
    const target = local.get(ref);
    return method === undefined ? target(...args) : target[method](...args);
  };
  return { encode, encodeError, decode, invoke };
}

/** Run `exportName` from `moduleUrl` in a worker; callbacks run synchronously on this thread. */
export async function runIsolatedUpdateCompatExport(moduleUrl, exportName, args) {
  const codec = createCodec("p");
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { [MARK]: true, moduleUrl, exportName, port: port2, flag },
    transferList: [port2],
    env: SHARE_ENV,
    execArgv: [],
  });
  const pending = new Map();
  let nextCall = 0;
  /** @type {Error | undefined} */
  let failure;
  const callWorker = (ref, method, callArgs) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = nextCall++;
      pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ type: "invoke", id, ref, method, args: codec.encode(callArgs) }, []);
    });
  port1.on("message", (request) => {
    let reply;
    try {
      const value = codec.invoke(
        request.ref,
        request.method,
        codec.decode(request.args, callWorker),
      );
      if (typeof value?.then === "function") {
        // The worker waits synchronously and cannot await caller promises.
        value.then(undefined, () => undefined);
        reply = { ok: true, value: undefined };
      } else {
        reply = { ok: true, value: codec.encode(value) };
      }
    } catch (error) {
      reply = { ok: false, error: codec.encodeError(error) };
    }
    port1.postMessage(reply, []);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });
  port1.unref();
  worker.on("message", (message) => {
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (pending.size === 0) {
      worker.unref();
    }
    // Apply the worker's view of caller-owned arguments before settling.
    codec.decode(message.args, callWorker);
    if (message.ok) {
      entry.resolve(codec.decode(message.value, callWorker));
    } else {
      entry.reject(codec.decode(message.error, callWorker));
    }
  });
  const settle = (error) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    for (const entry of pending.values()) {
      entry.reject(failure);
    }
    pending.clear();
  };
  worker.on("error", settle);
  worker.on("exit", (code) => {
    port1.close();
    settle(new Error(`Update compatibility worker exited with code ${code}`));
  });
  // Returned callbacks keep the unreferenced worker; otherwise it exits after flushing output.
  return await callWorker(null, exportName, args);
}

/** Bind one bridged export; each call runs in its own worker. */
export function isolatedUpdateCompatExport(bridgeUrl, specifier, exportName) {
  const moduleUrl = new URL(specifier, bridgeUrl).href;
  return (...args) => runIsolatedUpdateCompatExport(moduleUrl, exportName, args);
}

async function runWorker() {
  const { moduleUrl, port, flag } = workerData;
  const codec = createCodec("w");
  const callParent = (ref, method, args) => {
    Atomics.store(flag, 0, 0);
    port.postMessage({ ref, method, args: codec.encode(args) }, []);
    Atomics.wait(flag, 0, 0);
    const reply = receiveMessageOnPort(port)?.message;
    if (!reply) {
      throw new Error("Update compatibility caller did not answer");
    }
    if (!reply.ok) {
      throw codec.decode(reply.error, callParent);
    }
    return codec.decode(reply.value, callParent);
  };
  // Current code must not claim custody of the older updater's executor.
  globalThis[Symbol.for("openclaw.updateCompat.olderUpdater")] = true;
  const module = await import(moduleUrl);
  const handle = async (message) => {
    let args = [];
    try {
      args = codec.decode(message.args, callParent);
      const value =
        message.ref === null
          ? await module[message.method](...args)
          : await codec.invoke(message.ref, message.method, args);
      // Send back caller-owned arguments so in-place mutations reach the caller.
      parentPort.postMessage(
        {
          id: message.id,
          ok: true,
          value: codec.encode(value),
          args: codec.encode(args),
        },
        [],
      );
      if (message.ref === null && !containsFunction(value)) {
        parentPort.close();
      }
    } catch (error) {
      parentPort.postMessage(
        {
          id: message.id,
          ok: false,
          error: codec.encodeError(error),
          args: codec.encode(args),
        },
        [],
      );
      if (message.ref === null) {
        parentPort.close();
      }
    }
  };
  parentPort.on("message", (message) => {
    if (message.type === "invoke") {
      void handle(message);
    }
  });
}

if (!isMainThread && workerData?.[MARK] === true) {
  await runWorker();
}
