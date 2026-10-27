// Diagnostic only, Node 26: pass --gateway-preload "$PWD/scripts/perf/agent-event-frame-census-preload.mjs"
// to team-shape-stress.ts with --mode timing (this preload owns its allocation sampler).
// For a census: --smoke-seconds 60 --warmup-ms 0 --list-weight 2 --poll-ms 5000.
// This is not timing proof. Read frame-census.json and frame-census.heapprofile
// beside the workload artifacts. Count native enterWith copies separately from
// AsyncResource entries, which exchange frame references without copying maps.
// In the profile, Map directly below native enterWith below eventEnterWith owns
// frame-copy allocation. Census/stack-label allocations are not production work.
// No store values or event payloads are recorded; map keys, undefined occupancy,
// call sites, and operation counts describe synchronous agent-event dispatch,
// RPC handler prefixes, worker sends, and plugin invocations. Async continuations
// are excluded: an async handler's census ends as soon as its first await yields.
import hooks from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
const require = createRequire(import.meta.url);
if (isMainThread) {
  const { parse } = require("acorn");
  const NativeALS = hooks.AsyncLocalStorage;
  const NativeResource = hooks.AsyncResource;
  // oxlint-disable-next-line typescript/unbound-method -- Instrumentation retains the original method; every call supplies its receiver with .call.
  const nativeEnter = NativeALS.prototype.enterWith;
  // oxlint-disable-next-line typescript/unbound-method -- Instrumentation retains the original method; every call supplies its receiver with .call.
  const nativeRun = NativeALS.prototype.run;
  // oxlint-disable-next-line typescript/unbound-method -- Instrumentation retains the original method; every call supplies its receiver with .call.
  const nativeScope = NativeResource.prototype.runInAsyncScope;
  const resourceTypes = new WeakMap();
  const stores = new WeakMap();
  const storeRecords = [];
  const construction = () => new Error().stack.split("\n").slice(2, 10);
  const storeRecord = (store) => {
    let record = stores.get(store);
    if (!record) {
      record = {
        id: storeRecords.length,
        name: store.name,
        construction: ["created before preload"],
        seen: 0,
        unset: 0,
        set: 0,
      };
      storeRecords.push(record);
      stores.set(store, record);
    }
    return record;
  };
  Object.defineProperty(hooks, "AsyncLocalStorage", {
    configurable: true,
    enumerable: true,
    value: class CensusAsyncLocalStorage extends NativeALS {
      constructor(...args) {
        super(...args);
        const record = storeRecord(this);
        record.construction = construction();
      }
    },
  });
  hooks.AsyncResource = class CensusAsyncResource extends NativeResource {
    constructor(type, ...args) {
      super(type, ...args);
      resourceTypes.set(this, type);
    }
  };
  syncBuiltinESMExports();
  // Discover Node's frame class through a throwaway resource and restore the
  // exact original frame, so the probe itself adds no key to Gateway frames.
  let Frame;
  const probe = new NativeResource("census-probe");
  nativeScope.call(probe, () => {
    const storage = new NativeALS();
    nativeEnter.call(storage, true);
    const resource = new NativeResource("census-frame");
    const key = Object.getOwnPropertySymbols(resource).find(
      (symbol) => symbol.description === "context_frame",
    );
    Frame = Object.getPrototypeOf(resource[key]).constructor;
  });
  if (typeof Frame.current !== "function") {
    throw new Error("Unsupported Node frame representation");
  }
  let enabled = false;
  let active;
  const events = {};
  const patterns = new Map();
  const transitions = new Map();
  const installed = [];
  const snapshot = () => {
    const frame = Frame.current();
    const keys = [];
    for (const [store, value] of frame ?? []) {
      const record = storeRecord(store);
      record.seen++;
      record[value === undefined ? "unset" : "set"]++;
      keys.push(`${record.id}:${value === undefined ? "u" : "v"}`);
    }
    return { size: frame?.size ?? 0, keys };
  };
  globalThis[Symbol.for("openclaw.frame-census")] = {
    begin(stream) {
      if (!enabled || stream === undefined) {
        return undefined;
      }
      const parent = active;
      const state = snapshot();
      const group = (events[stream] ??= {
        events: 0,
        copies: 0,
        runCalls: 0,
        sameValueRuns: 0,
        resources: 0,
        copiedSlots: 0,
        sizes: {},
        resourceTypes: {},
      });
      group.events++;
      group.sizes[state.size] = (group.sizes[state.size] ?? 0) + 1;
      const signature = `${stream}|${state.keys.join(",")}`;
      const pattern = patterns.get(signature) ?? { stream, ...state, events: 0 };
      pattern.events++;
      patterns.set(signature, pattern);
      active = { parent, group, stream };
      return active;
    },
    end(current) {
      if (current) {
        active = current.parent;
      }
    },
  };
  function eventEnterWith(value) {
    const before = Frame.current();
    const size = before?.size ?? 0;
    const record = storeRecord(this);
    const key = `${active.stream}|${record.id}|${size}|${value === undefined ? "u" : "v"}`;
    let transition = transitions.get(key);
    if (!transition) {
      transition = {
        stream: active.stream,
        store: record.id,
        sizeBefore: size,
        unsetAfter: value === undefined,
        count: 0,
      };
      transitions.set(key, transition);
    }
    active.group.copies++;
    active.group.copiedSlots += size;
    transition.count++;
    // Sample attribution below this distinct function isolates real frame
    // allocation from census bookkeeping and non-event Gateway traffic.
    return nativeEnter.call(this, value);
  }
  NativeALS.prototype.enterWith = function (value) {
    return active ? eventEnterWith.call(this, value) : nativeEnter.call(this, value);
  };
  NativeALS.prototype.run = function (value, callback, ...args) {
    if (active) {
      active.group.runCalls++;
      active.group.sameValueRuns += Object.is(this.getStore(), value) ? 1 : 0;
    }
    return nativeRun.call(this, value, callback, ...args);
  };
  NativeResource.prototype.runInAsyncScope = function (callback, receiver, ...args) {
    if (active) {
      active.group.resources++;
      const type = resourceTypes.get(this) ?? "native-or-preload-resource";
      active.group.resourceTypes[type] = (active.group.resourceTypes[type] ?? 0) + 1;
    }
    return nativeScope.call(this, callback, receiver, ...args);
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.includes("/dist/") || result.source == null) {
        return result;
      }
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      if (
        !/function (?:dispatchAgentEvent|handleGatewayRequest|sendWorkerTaskInput)\b|class PluginInstance\b|PluginInstance\s*=\s*class\b/.test(
          source,
        )
      ) {
        return result;
      }
      const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const targets = [];
      const visit = (node, className) => {
        if (!node || typeof node !== "object") {
          return;
        }
        if (node.type === "VariableDeclarator" && node.init?.type === "ClassExpression") {
          visit(node.init, node.id?.name);
          return;
        }
        const currentClass =
          node.type === "ClassDeclaration" || node.type === "ClassExpression"
            ? (node.id?.name ?? className)
            : className;
        const name = node.type === "FunctionDeclaration" ? node.id?.name : undefined;
        if (name === "dispatchAgentEvent" || name === "handleGatewayRequest") {
          const argument = node.params[0];
          if (argument.type !== "Identifier") {
            throw new Error(`Unsupported ${name} parameter in ${url}`);
          }
          const label =
            name === "dispatchAgentEvent"
              ? `${argument.name}.stream`
              : `(["chat.send", "sessions.list"].includes(${argument.name}.req.method) ? "rpc:" + ${argument.name}.req.method : undefined)`;
          targets.push({ node, name, label });
        } else if (name === "sendWorkerTaskInput") {
          targets.push({ node, name, label: '"worker:dispatch"' });
        } else if (
          currentClass === "PluginInstance" &&
          node.type === "MethodDefinition" &&
          node.key.name === "invoke"
        ) {
          targets.push({
            node: node.value,
            name: "PluginInstance.invoke",
            label: '"plugin:invoke"',
          });
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            for (const child of value) {
              visit(child, currentClass);
            }
          } else if (value && typeof value === "object") {
            visit(value, currentClass);
          }
        }
      };
      visit(program);
      const census = 'globalThis[Symbol.for("openclaw.frame-census")]';
      let instrumented = source;
      for (const { node, name, label } of targets.toSorted((a, b) => b.node.start - a.node.start)) {
        const begin = node.body.start + 1;
        const end = node.body.end - 1;
        // Invoke the async body lexically but restore the global census before
        // yielding, so overlapping RPC continuations cannot borrow this label.
        const asyncBegin = node.async ? "return (async () => {" : "";
        const asyncEnd = node.async ? "})();" : "";
        installed.push({ url, function: name });
        instrumented =
          instrumented.slice(0, begin) +
          `\nconst __census = ${census}.begin(${label}); try { ${asyncBegin}\n` +
          instrumented.slice(begin, end) +
          `\n${asyncEnd} } finally { ${census}.end(__census); }\n` +
          instrumented.slice(end);
      }
      return { ...result, source: instrumented };
    },
  });
  const inspector = new Session();
  inspector.connect();
  let output;
  let captured = false;
  function save(complete) {
    if (!output || captured) {
      return;
    }
    captured = true;
    enabled = false;
    writeFileSync(
      path.join(output, "frame-census.json"),
      JSON.stringify(
        {
          node: process.version,
          complete,
          scope:
            "Entry frames and synchronous prefixes: dispatchAgentEvent, chat.send/sessions.list RPCs, worker sends, PluginInstance.invoke. Async continuations excluded; main isolate only. Diagnostic instrumentation; not timing evidence.",
          installed,
          events,
          patterns: [...patterns.values()],
          transitions: [...transitions.values()],
          stores: storeRecords,
        },
        null,
        2,
      ),
    );
    inspector.post("HeapProfiler.stopSampling", (error, result) => {
      if (error) {
        throw error;
      }
      writeFileSync(path.join(output, "frame-census.heapprofile"), JSON.stringify(result.profile));
    });
  }
  process.on("exit", () => save(false));
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action === "start") {
      output = message.output;
      inspector.post(
        "HeapProfiler.startSampling",
        {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        },
        (error) => {
          if (error) {
            throw error;
          }
          enabled = true;
        },
      );
    } else if (message.action === "stop") {
      save(true);
    }
  });
  process.channel?.unref();
}
