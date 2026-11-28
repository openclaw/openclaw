// Task-only source/bundle instrumentation. No production files or public timing policy change.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";

const key = 'globalThis[Symbol.for("openclaw.perf.native-chat-start")]';
const probes = [
  {
    name: "completion-owner",
    marker:
      /async function runIsolatedCompletion\(\s*params(?:\s*:\s*RunIsolatedCompletionParams)?[,]?\s*\)(?:\s*:\s*Promise<IsolatedCompletionResult>)?\s*\{/gu,
    replace: true,
    code: `async function runIsolatedCompletion(params) {
      return ${key}.withOwner(params.purpose, () => __nativeChatOwnedCompletion(params));
    }
    async function __nativeChatOwnedCompletion(params) {`,
    emitted: {
      marker: /async function runIsolatedCompletion\(([A-Za-z_$][\w$]*)\)\{/gu,
      code: ([, params]) => `async function runIsolatedCompletion(${params}) {
        return ${key}.withOwner(${params}.purpose, () => __nativeChatOwnedCompletion(${params}));
      }
      async function __nativeChatOwnedCompletion(${params}) {`,
    },
  },
  {
    name: "request-correlation",
    owner: "function createModelLifecycle(",
    marker: /modelRequestBodyState\(requestOptions\)\.onBytes\s*=/gu,
    before: true,
    code: `${key}.headers(requestOptions, ctx.runId, callId);`,
  },
  {
    name: "acknowledged",
    marker: /diagnostics\.acknowledge\([^;\r\n]*\);/gu,
    code: `${key}("acknowledged", clientRunId);`,
    emitted: {
      marker:
        /[A-Za-z_$][\w$]*\(true,[A-Za-z_$][\w$]*,void 0,\{runId:([A-Za-z_$][\w$]*)\}\);[A-Za-z_$][\w$]*\?\.finish\(\);[A-Za-z_$][\w$]*\.acknowledge\(\);/gu,
      code: ([, clientRunId]) => `${key}("acknowledged", ${clientRunId});`,
    },
  },
  {
    name: "run-start",
    marker: /queuedFollowup\.onRunStarted\(runId\);/gu,
    code: `${key}("run-start", clientRunId, runId);`,
    emitted: {
      marker:
        /const onAgentRunStart=\(([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)=>\{[A-Za-z_$][\w$]*\.onRunStarted\(\1\);(?=[\s\S]{0,512}?\1!==([A-Za-z_$][\w$]*)\?\{agentRunId:\1\})/gu,
      code: ([, runId, clientRunId]) => `${key}("run-start", ${clientRunId}, ${runId});`,
    },
  },
  {
    name: "provider-start",
    owner: "function createModelLifecycle(",
    marker: /const\s+startedAt\s*=\s*Date\.now\(\);/gu,
    code: `${key}("provider-start", params.ctx.runId, callId);`,
  },
  {
    name: "provider-serialized",
    owner: "function createModelLifecycle(",
    marker: /observer\.state\.requestPayloadBytes\s*=\s*bytes;/gu,
    code: `${key}("provider-serialized", ctx.runId, callId);`,
  },
  {
    name: "provider-headers",
    owner: "function createModelLifecycle(",
    marker: /observer\.state\.responseStatus\s*=\s*response\.status;/gu,
    code: `${key}("provider-headers", ctx.runId, callId, response.status);`,
  },
  {
    name: "provider-output",
    owner: "function createModelLifecycle(",
    marker: /observer\.observeResponseChunk\(startedAt,\s*chunk\);/gu,
    code: `if (isModelOutputDelta(chunk)) ${key}("provider-output", params.ctx.runId, callId);`,
  },
];

function emittedProviderProbes(source) {
  const identifier = "[A-Za-z_$][\\w$]*";
  const unique = (marker, name) => {
    const matches = [...source.matchAll(marker)];
    assert.equal(
      matches.length,
      1,
      `Unsupported or ambiguous emitted native chat binding: ${name}`,
    );
    return matches[0];
  };
  const [, params, callId] = unique(
    /function createModelLifecycle\(([A-Za-z_$][\w$]*)\)\{const ([A-Za-z_$][\w$]*)=\1\.ctx\.nextCallId\(\);/gu,
    "model lifecycle",
  );
  const [, observer] = unique(
    new RegExp(`const (${identifier})=${RegExp.escape(params)}\\.createObserver\\(`, "gu"),
    "model observer",
  );
  const date = unique(
    /const ([A-Za-z_$][\w$]*)=Date\.now\(\);(?=emitDiagnosticsTimelineEvent\(\{type:`mark`,name:`provider\.request\.started`)/gu,
    "provider start",
  );
  const identity = "__nativeChatCaptureIdentity";
  assert(!source.includes(identity), "Conflicting emitted native chat identity binding");
  // Emitted callbacks can shadow the lifecycle's parameter and call-ID bindings.
  return [
    {
      name: "request-correlation",
      marker: new RegExp(`modelRequestBodyState\\((${identifier})\\)\\.onBytes=`, "gu"),
      before: true,
      code: ([, options]) => `${key}.headers(${options}, ${identity}.runId, ${identity}.callId);`,
    },
    {
      name: "provider-start",
      marker: new RegExp(RegExp.escape(date[0]), "gu"),
      code: `const ${identity} = {runId: ${params}.ctx.runId, callId: ${callId}};
        ${key}("provider-start", ${identity}.runId, ${identity}.callId);`,
    },
    {
      name: "provider-serialized",
      marker: new RegExp(
        `${RegExp.escape(observer)}\\.state\\.requestPayloadBytes=${identifier};`,
        "gu",
      ),
      code: `${key}("provider-serialized", ${identity}.runId, ${identity}.callId);`,
    },
    {
      name: "provider-headers",
      marker: new RegExp(
        `${RegExp.escape(observer)}\\.state\\.responseStatus=(${identifier})\\.status;`,
        "gu",
      ),
      code: ([, response]) =>
        `${key}("provider-headers", ${identity}.runId, ${identity}.callId, ${response}.status);`,
    },
    {
      name: "provider-output",
      marker: new RegExp(
        `${RegExp.escape(observer)}\\.observeResponseChunk\\(${RegExp.escape(date[1])},(${identifier})\\);`,
        "gu",
      ),
      code: ([, chunk]) =>
        `if (isModelOutputDelta(${chunk})) ${key}("provider-output", ${identity}.runId, ${identity}.callId);`,
    },
  ];
}

/** Qualify exact owner anchors before returning any instrumented code. */
export function instrumentNativeChatStartModule(source) {
  let activeProbes = probes.map((probe) =>
    probe.emitted &&
    ![...source.matchAll(probe.marker)].length &&
    [...source.matchAll(probe.emitted.marker)].length
      ? Object.assign({}, probe, probe.emitted)
      : probe,
  );
  if (
    source.includes("function createModelLifecycle(") &&
    ![...source.matchAll(probes.find((probe) => probe.name === "provider-start").marker)].length
  ) {
    activeProbes = [
      ...activeProbes.filter((probe) => !probe.owner),
      ...emittedProviderProbes(source).map((probe) =>
        Object.assign(probe, { owner: "function createModelLifecycle(" }),
      ),
    ];
  }
  const selected = activeProbes.filter(
    (probe) =>
      (!probe.owner || source.includes(probe.owner)) &&
      [...source.matchAll(probe.marker)].length > 0,
  );
  if (!selected.length) {
    return undefined;
  }
  if (source.includes("function createModelLifecycle(")) {
    for (const probe of activeProbes.filter((entry) => entry.owner)) {
      assert(
        [...source.matchAll(probe.marker)].length > 0,
        `Missing native chat capture anchor: ${probe.name}`,
      );
    }
  }
  let transformed = source;
  for (const probe of selected) {
    const matches = [...source.matchAll(probe.marker)];
    assert.equal(matches.length, 1, `Ambiguous native chat capture anchor: ${probe.name}`);
    const code = typeof probe.code === "function" ? probe.code(matches[0]) : probe.code;
    transformed = transformed.replace(probe.marker, (matched) =>
      probe.replace ? code : probe.before ? `${code}\n${matched}` : `${matched}\n${code}`,
    );
  }
  return { source: transformed, anchors: selected.map((probe) => probe.name) };
}

if (isMainThread && process.env.OPENCLAW_PERF_CHAT_CAPTURE_DIR) {
  const directory = path.resolve(process.env.OPENCLAW_PERF_CHAT_CAPTURE_DIR);
  assert(process.env.OPENCLAW_PERF_CHAT_OWNER_ROOT, "Capture requires an explicit owner root");
  const root = realpathSync(process.env.OPENCLAW_PERF_CHAT_OWNER_ROOT);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  const relativeEntry = entry ? path.relative(root, entry) : undefined;
  const payloadEntry =
    relativeEntry !== undefined &&
    !relativeEntry.startsWith("..") &&
    !path.isAbsolute(relativeEntry);
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `native-chat-${process.pid}.jsonl`);
  const installed = new Set();
  const observed = new Set();
  const completionOwner = new AsyncLocalStorage();
  const agentRuns = new Set();
  const purposes = new Set(["session-activity-summary", "session-observer", "session-title"]);
  const pending = [];
  let scheduled = false;
  let count = 0;
  let droppedEvents = 0;
  let unclassifiedIdentities = 0;
  let writeFailures = 0;
  const flush = () => {
    scheduled = false;
    if (pending.length) {
      try {
        appendFileSync(output, pending.splice(0).join(""));
      } catch {
        writeFailures++;
        if (writeFailures === 1) {
          console.error(
            "Native chat capture write failed; discard this diagnostic run and check its task-owned output.",
          );
        }
      }
    }
  };
  const record = (value, terminal = false) => {
    if (!terminal && count++ >= 10_000) {
      droppedEvents++;
      return;
    }
    pending.push(`${JSON.stringify({ pid: process.pid, atMs: performance.now(), ...value })}\n`);
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  };
  writeFileSync(
    output,
    `${JSON.stringify({
      type: "capture-start",
      pid: process.pid,
      ppid: process.ppid,
      architecture: process.arch,
      platform: process.platform,
      clock: "process-local performance.now",
      role: process.argv.includes("gateway") && process.argv.includes("run") ? "gateway" : "helper",
      entryKind: entry ? (payloadEntry ? "payload-module" : "external-module") : "inline",
      ...(payloadEntry && existsSync(entry)
        ? { entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex") }
        : {}),
      instrumentation: "private loader hooks; not uninstrumented performance evidence",
    })}\n`,
    { flag: "wx" },
  );
  globalThis[Symbol.for("openclaw.perf.native-chat-start")] = (phase, runId, relatedId, status) => {
    // Only UUIDs from this synthetic workload; never persist message/model/path values.
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
    if (
      !(typeof runId === "string" && uuid.test(runId)) ||
      !(
        relatedId === undefined ||
        (typeof relatedId === "string" &&
          (uuid.test(relatedId) || /^[0-9a-f-]{36}:model:[1-9]\d*$/iu.test(relatedId)))
      )
    ) {
      unclassifiedIdentities++;
      return;
    }
    const identity = `${phase}:${runId}:${relatedId ?? ""}`;
    if (phase === "run-start") {
      agentRuns.add(relatedId);
    }
    if (phase === "provider-output") {
      if (observed.has(identity)) {
        return;
      }
      observed.add(identity);
    }
    if (
      phase === "provider-headers" &&
      !(Number.isInteger(status) && status >= 100 && status <= 599)
    ) {
      unclassifiedIdentities++;
      return;
    }
    record({
      type: "mark",
      phase,
      runId,
      ...(relatedId ? { relatedId } : {}),
      ...(phase === "provider-headers" ? { status } : {}),
      ...(phase === "provider-start"
        ? agentRuns.has(runId)
          ? { owner: "agent-turn" }
          : {
              owner: completionOwner.getStore()?.purpose ?? "unattributed",
              ...(completionOwner.getStore()
                ? { ownerOperationId: completionOwner.getStore().operationId }
                : {}),
            }
        : {}),
    });
  };
  const tracker = globalThis[Symbol.for("openclaw.perf.native-chat-start")];
  tracker.withOwner = (purpose, run) =>
    completionOwner.run(
      {
        purpose: purposes.has(purpose) ? purpose : "unattributed",
        operationId: randomUUID(),
      },
      run,
    );
  tracker.headers = (options, runId, callId) => {
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
    if (
      typeof runId !== "string" ||
      !uuid.test(runId) ||
      typeof callId !== "string" ||
      !(
        uuid.test(callId) ||
        (callId.startsWith(`${runId}:model:`) && /^[1-9]\d*$/u.test(callId.slice(runId.length + 7)))
      )
    ) {
      unclassifiedIdentities++;
      return;
    }
    options.headers = {
      ...options.headers,
      "x-openclaw-perf-pid": String(process.pid),
      "x-openclaw-perf-run": runId,
      "x-openclaw-perf-call": callId,
    };
  };
  const callers = new Set([
    "session-manager.write",
    "session-manager.note",
    "session-actor.command",
    "history.model-context",
    "history.hydration",
    "session-reclamation.close",
  ]);
  channel("openclaw.agent-database.reservation").subscribe((event) => {
    if (!["direct", "worker", "ordered-read"].includes(event?.operation)) {
      return;
    }
    const fields = {
      type: "reservation",
      operation: event.operation,
      caller: callers.has(event.caller) ? event.caller : "unlabeled",
      blockingCaller: callers.has(event.blockingCaller) ? event.blockingCaller : "unlabeled",
    };
    for (const name of [
      "queueWaitMs",
      "writerExecutionMs",
      "completionDelayMs",
      "transactionCount",
    ]) {
      if (typeof event[name] === "number" && Number.isFinite(event[name])) {
        fields[name] = event[name];
      }
    }
    record(fields);
  });
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:") || result.source == null) {
        return result;
      }
      const filename = fileURLToPath(url);
      const relative = path.relative(root, filename);
      if (
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !/\.(?:mjs|ts)$/u.test(filename) ||
        /(?:\.test|test-support)\./u.test(filename) ||
        relative.split(path.sep).includes("node_modules")
      ) {
        return result;
      }
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      const transformed = instrumentNativeChatStartModule(source);
      if (!transformed) {
        return result;
      }
      for (const anchor of transformed.anchors) {
        assert(!installed.has(anchor), `Duplicate native chat owner: ${anchor}`);
        installed.add(anchor);
      }
      record({
        type: "owner-installed",
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        anchors: transformed.anchors,
      });
      return { ...result, source: transformed.source };
    },
  });
  process.once("exit", (exitCode) => {
    record(
      {
        type: "capture-end",
        anchors: [...installed],
        droppedEvents,
        unclassifiedIdentities,
        writeFailures,
        exitCode,
      },
      true,
    );
    flush();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      "check-owner-root": { type: "string" },
      "expected-build": { type: "string" },
      "expected-owner-hash": { type: "string", multiple: true },
    },
  });
  assert(values["check-owner-root"], "Pass --check-owner-root <source checkout or packaged app>");
  const root = realpathSync(values["check-owner-root"]);
  const sourceOwners = [
    "src/gateway/server-methods/chat-send-input-dispatch.ts",
    "src/gateway/server-methods/chat-send-agent-dispatch.ts",
    "src/agents/embedded-agent-runner/run/attempt.model-diagnostic-lifecycle.ts",
    "src/agents/isolated-completion.ts",
  ];
  const source = existsSync(path.join(root, ...sourceOwners[0].split("/")));
  const directory = source ? root : path.join(root, "dist");
  const files = source
    ? sourceOwners.map((name) => path.join(root, ...name.split("/")))
    : readdirSync(directory)
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => path.join(directory, name));
  const coverage = new Map();
  const owners = [];
  for (const filename of files) {
    const text = readFileSync(filename, "utf8");
    const transformed = instrumentNativeChatStartModule(text);
    if (!transformed) {
      continue;
    }
    for (const anchor of transformed.anchors) {
      assert(!coverage.has(anchor), `Duplicate native chat owner: ${anchor}`);
      coverage.set(anchor, true);
    }
    owners.push({
      file: path.relative(root, filename),
      sourceSha256: createHash("sha256").update(text).digest("hex"),
      anchors: transformed.anchors,
    });
  }
  for (const probe of probes) {
    assert(coverage.has(probe.name), `Unqualified owner layout; missing ${probe.name}`);
  }
  const buildInfo = path.join(root, "dist", "build-info.json");
  const build = existsSync(buildInfo) ? JSON.parse(readFileSync(buildInfo, "utf8")) : undefined;
  if (values["expected-build"]) {
    assert.equal(build?.commit, values["expected-build"], "Unexpected measured payload commit");
  }
  if (values["expected-owner-hash"]) {
    assert.deepEqual(
      owners
        .map((owner) => owner.sourceSha256)
        .toSorted((left, right) => left.localeCompare(right)),
      values["expected-owner-hash"].toSorted((left, right) => left.localeCompare(right)),
      "Unexpected measured owner content",
    );
  }
  console.log(
    JSON.stringify(
      {
        layout: source ? "source-only" : "built-dist",
        ...(build ? { build } : {}),
        preloadSha256: createHash("sha256")
          .update(readFileSync(fileURLToPath(import.meta.url)))
          .digest("hex"),
        owners,
        execution: "not exercised; offline anchor qualification only",
      },
      null,
      2,
    ),
  );
}
