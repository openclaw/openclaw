import { setImmediate } from "node:timers/promises";
import { types } from "node:util";
import { getHeapStatistics } from "node:v8";
import { createContext, Script, type Context } from "node:vm";
import { observeGcSamples } from "../infra/gc-observer.js";
import { publishWorkerGcStorm } from "../infra/worker-memory.js";
import { serveWorkerTasks, type WorkerTaskChannel } from "../infra/worker-task-server.js";
import { CODE_MODE_CONTROLLER_SOURCE } from "./code-mode-controller-source.js";
import { CodeModeHeadlessTimeoutError } from "./code-mode-errors.js";
import {
  boundCodeModeError,
  captureCodeModeValue,
  EMPTY_CODE_MODE_OUTPUT,
  type CodeModeOutputSource,
} from "./code-mode-json.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import {
  buildUserSource,
  normalizeSourceStack,
  USER_SOURCE_FILE,
  type SourceLocation,
} from "./code-mode-source-location.js";
import { CODE_MODE_MODULE_ACCESS_ERROR, prepareSource } from "./code-mode-source.js";
import {
  CODE_MODE_BRIDGE_METHODS,
  type CodeModeConfig,
  type CodeModeFailurePhase,
  type CodeModeNodeInput,
  type CodeModeWorkerContinuation,
  type CodeModeWorkerThreadResult,
  type PendingBridgeRequest,
  type SettledBridgeRequest,
} from "./code-mode-worker-types.js";
import { ToolInputError } from "./tool-input-error.js";

type NodeInput = CodeModeNodeInput;
type NodeResult = CodeModeWorkerThreadResult<undefined>;

type GuestOutcome = { ok: boolean; json: string };
type NodeCell = {
  context: Context;
  gcAttribution: NodeInput["gcAttribution"];
  config: CodeModeConfig;
  location: SourceLocation;
  pendingRequests: PendingBridgeRequest[];
  canceledRequestIds: string[];
  replies?: SettledBridgeRequest[];
  replyIndex: number;
  rejections: Map<Promise<unknown>, unknown>;
  outcome?: GuestOutcome;
  admissionError?: string;
  networkContentObserved?: true;
  deadline: number;
  progress: CodeModeNodeProgress;
};

// Each pool owns one cell and keeps its worker until that cell completes or expires.
let cell: NodeCell | undefined;
process.on("unhandledRejection", (reason, promise) => cell?.rejections.set(promise, reason));
process.on("rejectionHandled", (promise) => cell?.rejections.delete(promise));

// Pressure belongs to the isolate, including time between checkpoints and idle GC.
let gcStartedAt = performance.now();
let majorCollections = 0;
let stormStartedAt = gcStartedAt;
let stormCollections = 0;
let consecutiveStormWindows = 0;
let lastStormWarningAt = -Infinity;
let cellCount = 0;
let workerId: string | undefined;
observeGcSamples((samples) => {
  for (const sample of samples) {
    if (sample.kind === "mark_sweep_compact") {
      majorCollections++;
      stormCollections++;
    }
  }
  const now = performance.now();
  const stormIntervalMs = now - stormStartedAt;
  if (stormIntervalMs >= 10_000) {
    const storming = stormCollections > stormIntervalMs / 100;
    consecutiveStormWindows = storming ? Math.min(2, consecutiveStormWindows + 1) : 0;
    if (consecutiveStormWindows === 2 && workerId) {
      publishWorkerGcStorm({ retireWorkerId: workerId });
    }
    if (storming && now - lastStormWarningAt >= 60_000) {
      const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
      publishWorkerGcStorm({
        workerId,
        ...cell?.gcAttribution,
        cellCount,
        activeCellCount: cell ? 1 : 0,
        bridgeMethods: [...new Set(cell?.pendingRequests.map((request) => request.method) ?? [])],
        majorCollections: stormCollections,
        intervalMs: stormIntervalMs,
        heapUsed,
        heapTotal,
        external,
        arrayBuffers,
        heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
      });
      lastStormWarningAt = now;
    }
    stormStartedAt = now;
    stormCollections = 0;
  }
  const elapsedMs = now - gcStartedAt;
  if (elapsedMs < 1_000) {
    return;
  }
  // Frequent majors can thrash even with a modest GC time share. Sample heap only
  // after sustained collection; the host deadline still interrupts synchronous loops.
  if (majorCollections >= elapsedMs / 50) {
    const heap = getHeapStatistics();
    if (heap.used_heap_size >= heap.heap_size_limit * 0.85) {
      // A fatal worker error also retires a parked or warm isolate. Never let the
      // guest catch this and continue allocating; the host maps the native cause.
      throw Object.assign(
        new Error(
          "Code Mode worker stopped after sustained garbage collection near its JavaScript heap limit",
        ),
        {
          code: "ERR_CODE_MODE_GC_THRASH",
        },
      );
    }
  }
  gcStartedAt = now;
  majorCollections = 0;
});

const bridgeMethods = new Set<string>(CODE_MODE_BRIDGE_METHODS);

function isBridgeMethod(method: string): method is PendingBridgeRequest["method"] {
  return bridgeMethods.has(method);
}

function compileController(source: string): Script {
  return new Script(source, { filename: "openclaw-code-mode:controller.js" });
}

// Compile trusted control scripts once per worker; each cell still owns a fresh context.
const initializeScript = compileController(
  String.raw`
    (() => {
      // Keep native encoding prototypes private when this worker is reused.
      const Encoder = globalThis.__openclawNodeTextEncoder;
      const Decoder = globalThis.__openclawNodeTextDecoder;
      const Bytes = Uint8Array;
      delete globalThis.__openclawNodeTextEncoder;
      delete globalThis.__openclawNodeTextDecoder;
      Object.defineProperties(globalThis, {
        TextEncoder: { value: class TextEncoder {
          #encoder = new Encoder();
          get encoding() { return this.#encoder.encoding; }
          encode(input) { return new Bytes(this.#encoder.encode(input)); }
          encodeInto(input, destination) {
            const { read, written } = this.#encoder.encodeInto(input, destination);
            return { read, written };
          }
        }, enumerable: true },
        TextDecoder: { value: class TextDecoder {
          #decoder;
          constructor(label, options) { this.#decoder = new Decoder(label, options); }
          get encoding() { return this.#decoder.encoding; }
          get fatal() { return this.#decoder.fatal; }
          get ignoreBOM() { return this.#decoder.ignoreBOM; }
          decode(input, options) { return this.#decoder.decode(input, options); }
        }, enumerable: true },
      });
    })();

    Object.assign(globalThis, JSON.parse(__openclawNodeInit));
    delete globalThis.__openclawNodeInit;
    globalThis.__openclawMaxPendingToolCalls = __openclawNodeMaxPending;
    delete globalThis.__openclawNodeMaxPending;
    ${CODE_MODE_CONTROLLER_SOURCE}

    (() => {
      const finish = globalThis.__openclawNodeFinish;
      delete globalThis.__openclawNodeFinish;
      Object.defineProperties(globalThis, {
        __openclawNodeObserveResult: { value: (result) => {
          result.then(value => finish(true, value), error => finish(false, __openclawEncodeError(error)));
        }},
      });
    })();
  `,
);
const settleScript = compileController("__openclawSettleBridge()");
const drainScript = compileController(
  `(() => {
    const error = __openclawAdmissionError();
    if (!error) __openclawDrainQueuedRequests();
    return error;
  })()`,
);
const observeResultScript = compileController("__openclawNodeObserveResult(__openclawResult)");
const rejectionScript = compileController(
  `(() => {
    const error = __openclawNodeRejection;
    delete globalThis.__openclawNodeRejection;
    return __openclawEncodeError(error);
  })()`,
);

function evaluate(current: NodeCell, script: Script): unknown {
  const remaining = current.deadline - performance.now();
  if (remaining <= 0) {
    throw new CodeModeHeadlessTimeoutError();
  }
  // The host interrupts this Worker; vm.timeout would create a native thread per evaluation.
  return script.runInContext(current.context);
}

function sourceFrames(stack: string | undefined, location: SourceLocation): string[] {
  return (
    normalizeSourceStack(stack, location)
      ?.split("\n")
      .filter((line) => line.includes(USER_SOURCE_FILE) && /^\s+at /u.test(line)) ?? []
  );
}

function createCell(
  input: Extract<NodeInput, { kind: "exec" }>,
  source: string,
  startedAt: number,
  progress: CodeModeNodeProgress,
  consumed?: () => void,
): NodeCell {
  // Source validation consumes wall time; the separate headless CPU allowance starts here.
  const preparedAt = performance.now();
  const deadline = Math.min(
    startedAt + input.config.timeoutMs,
    preparedAt + (input.executionTimeoutMs ?? Infinity),
  );
  if (deadline <= preparedAt) {
    throw new CodeModeHeadlessTimeoutError();
  }
  const program = buildUserSource(source, input.prelude, "utf16");
  const context = createContext(Object.create(null), { microtaskMode: "afterEvaluate" });
  cellCount++;
  const current: NodeCell = {
    context,
    gcAttribution: input.gcAttribution,
    config: input.config,
    location: program.location,
    pendingRequests: [],
    canceledRequestIds: [],
    replyIndex: 0,
    rejections: new Map(),
    deadline,
    progress,
  };
  cell = current;
  context["__openclawNodeTextEncoder"] = TextEncoder;
  context["__openclawNodeTextDecoder"] = TextDecoder;
  context["__openclawHostRequest"] = (
    method: string,
    argsJson: string,
    id: string,
    stack: string,
  ) => {
    if (current.pendingRequests.length >= current.config.maxPendingToolCalls) {
      current.admissionError = "too many pending code mode tool calls";
      throw new Error(current.admissionError);
    }
    // The controller supplies strings; only JSON data and diagnostic stacks cross this bridge.
    if (!isBridgeMethod(method)) {
      throw new Error("unsupported code mode bridge method");
    }
    const args: unknown = JSON.parse(argsJson);
    if (!Array.isArray(args)) {
      throw new Error("invalid code mode bridge arguments: expected an array");
    }
    if (!id.startsWith(`bridge:${method}:`) || !/^bridge:[A-Za-z]+:[1-9]\d*$/u.test(id)) {
      throw new Error("invalid code mode bridge id");
    }
    if (current.pendingRequests.some((request) => request.id === id)) {
      throw new Error("duplicate code mode bridge id");
    }
    current.pendingRequests.push({ id, method, args });
    return sourceFrames(
      typeof stack === "string" ? stack.slice(0, 8192) : "",
      current.location,
    ).join("\n");
  };
  context["__openclawHostCancelRequest"] = (id: string) => {
    const index = current.pendingRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      current.pendingRequests.splice(index, 1);
      current.canceledRequestIds.push(id);
    }
  };
  context["__openclawHostTakeBridgeReply"] = () => {
    const request = current.replies?.[current.replyIndex];
    if (!request) {
      return undefined;
    }
    current.replyIndex++;
    const reply = { __proto__: null, id: request.id, ok: request.ok, json: request.json };
    request.json = "";
    return reply;
  };
  context["__openclawHostObserveNetworkContent"] = () => {
    current.networkContentObserved = true;
    current.progress.observeNetworkContent();
  };
  context["__openclawHostOutput"] = (json: string) => current.progress.append(json);
  context["__openclawNodeInit"] = new TextDecoder().decode(input.initialization);
  context["__openclawNodeMaxPending"] = input.config.maxPendingToolCalls;
  context["__openclawMaxOutputBytes"] = input.config.maxOutputBytes;
  context["__openclawNodeFinish"] = (ok: boolean, json: string) => {
    current.outcome = { ok, json };
  };
  progress.deadline = performance.timeOrigin + deadline;
  consumed?.();
  evaluate(current, initializeScript);
  evaluate(current, new Script(program.source, { filename: USER_SOURCE_FILE }));
  evaluate(current, observeResultScript);
  return current;
}

function settle(current: NodeCell, requests: SettledBridgeRequest[]): void {
  current.replies = requests;
  current.replyIndex = 0;
  try {
    evaluate(current, settleScript);
  } finally {
    current.replies = undefined;
    current.replyIndex = 0;
    for (const request of requests) {
      request.json = "";
    }
    requests.length = 0;
  }
}

function formatGuestFailure(
  current: NodeCell,
  json: string,
): { code: "invalid_input" | "internal_error"; error: string; failurePhase?: "bridge" } {
  // SAFETY: This worker's result observer encodes the error strings and bridge identity.
  const value = JSON.parse(json) as {
    name: string;
    message: string;
    stack: string;
    bridgeCode: "invalid_input" | "internal_error" | null;
  };
  if (
    value.bridgeCode === null &&
    value.name === "ReferenceError" &&
    /^(?:require|module|process) is not defined$/u.test(value.message)
  ) {
    return { code: "invalid_input", error: CODE_MODE_MODULE_ACCESS_ERROR };
  }
  return {
    code: value.bridgeCode ?? "internal_error",
    ...(value.bridgeCode === null ? {} : { failurePhase: "bridge" as const }),
    error: [`${value.name}: ${value.message}`, ...sourceFrames(value.stack, current.location)].join(
      "\n",
    ),
  };
}

function failed(
  code: "invalid_input" | "internal_error" | "timeout",
  error: string,
  output = EMPTY_CODE_MODE_OUTPUT,
  failurePhase?: CodeModeFailurePhase,
): Extract<NodeResult, { status: "failed" }> {
  return {
    status: "failed",
    code,
    error,
    output,
    failurePhase: failurePhase ?? (code === "invalid_input" ? "input" : "guest"),
    bridgeDispatchStarted: false,
  };
}

async function run(input: NodeInput, channel?: WorkerTaskChannel): Promise<NodeResult> {
  let output: CodeModeOutputSource = EMPTY_CODE_MODE_OUTPUT;
  let consumed = channel?.consumeInput;
  const consume = () => {
    const receipt = consumed;
    consumed = undefined;
    receipt?.();
  };
  const config = input.config;
  workerId = input.gcAttribution?.workerId;
  const startedAt = performance.now();
  const progress = new CodeModeNodeProgress(input.progress);
  try {
    const current =
      input.kind === "exec"
        ? createCell(input, prepareSource(input.source), startedAt, progress, consume)
        : cell;
    if (!current) {
      throw new Error("code mode continuation is no longer available");
    }
    if (input.kind === "resume") {
      current.progress = progress;
      current.config = config;
      current.deadline = performance.now() + config.timeoutMs;
      progress.deadline = performance.timeOrigin + current.deadline;
      if (current.networkContentObserved) {
        progress.observeNetworkContent();
      }
      current.pendingRequests = input.pendingRequests ?? [];
      current.canceledRequestIds = [];
      settle(current, input.settledRequests);
    }
    for (;;) {
      consume();
      const admissionError = current.admissionError ?? evaluate(current, drainScript);
      if (admissionError !== undefined && typeof admissionError !== "string") {
        throw new Error("invalid code mode admission error");
      }
      if (admissionError) {
        throw new ToolInputError(admissionError);
      }
      // Native rejection/handled notifications arrive at the end of the turn.
      await setImmediate();
      output = progress.output();
      const pending = !current.outcome;
      if (pending && current.pendingRequests.length === 0) {
        throw new ToolInputError("code mode promise is pending without host work");
      }
      if (pending || current.pendingRequests.length > 0) {
        const settlementMode = pending
          ? { kind: "awaiting" as const }
          : {
              kind: "draining" as const,
              requiredRequestIds: current.pendingRequests.map((request) => request.id),
            };
        const boundary = {
          pendingRequests: current.pendingRequests,
          canceledRequestIds: current.canceledRequestIds,
          settlementMode,
          output,
          // Worker-wide V8 allocation is diagnostic, not a per-context memory bound.
          memoryUsedBytes: getHeapStatistics().used_heap_size,
          ...(current.networkContentObserved ? { networkContentObserved: true as const } : {}),
        };
        if (!channel || !input.inlineHost) {
          return { status: "waiting", ...boundary, continuation: undefined };
        }
        const response = await channel.request({ status: "boundary", ...boundary });
        output = EMPTY_CODE_MODE_OUTPUT;
        consumed = response.consumed;
        // SAFETY: The task-bound host sends the shared typed continuation protocol.
        const command = response.input as CodeModeWorkerContinuation;
        if (command.kind === "checkpoint") {
          consume();
          return {
            status: "waiting",
            ...boundary,
            continuation: undefined,
            output: EMPTY_CODE_MODE_OUTPUT,
          };
        }
        if (command.kind !== "continue") {
          throw new Error("invalid code mode continuation");
        }
        if (
          !Number.isFinite(command.timeoutMs) ||
          command.timeoutMs <= 0 ||
          command.timeoutMs > config.timeoutMs
        ) {
          throw new Error("invalid code mode continuation timeout");
        }
        current.deadline = performance.now() + command.timeoutMs;
        current.pendingRequests = command.pendingRequests;
        current.canceledRequestIds = [];
        settle(current, command.settledRequests);
        continue;
      }
      const outcome = current.outcome!;
      let failureJson = outcome.ok ? undefined : outcome.json;
      if (outcome.ok && current.rejections.size > 0) {
        current.context["__openclawNodeRejection"] = current.rejections.values().next().value;
        failureJson = String(evaluate(current, rejectionScript));
      }
      if (failureJson !== undefined) {
        const failure = formatGuestFailure(current, failureJson);
        channel?.notify({
          status: "failure",
          error: JSON.parse(failureJson),
          failurePhase: failure.failurePhase ?? "guest",
        });
        return failed(
          failure.code,
          boundCodeModeError(failure.error, config.maxOutputBytes),
          output,
          failure.failurePhase,
        );
      }
      return {
        status: "completed",
        output,
        value: captureCodeModeValue(
          JSON.parse(outcome.json),
          config.maxOutputBytes,
          input.retainFinalValue
            ? Math.min(config.memoryLimitBytes, config.maxSnapshotBytes)
            : config.maxOutputBytes,
        ),
      };
    }
  } catch (error) {
    const timeout = error instanceof CodeModeHeadlessTimeoutError;
    // Guest exceptions arrive through the observed outcome; this catch owns worker failures.
    const failurePhase =
      error instanceof ToolInputError ? "input" : timeout && progress.deadline ? "guest" : "host";
    channel?.notify({
      status: "failure",
      error: types.isNativeError(error)
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
      failurePhase,
    });
    if (cell && output.count === 0 && !timeout) {
      output = progress.output();
    }
    return failed(
      timeout ? "timeout" : error instanceof ToolInputError ? "invalid_input" : "internal_error",
      boundCodeModeError(
        timeout
          ? "code mode timeout exceeded"
          : types.isNativeError(error)
            ? error.message
            : String(error),
        config.maxOutputBytes,
      ),
      timeout ? progress.output() : output,
      failurePhase,
    );
  } finally {
    // Rejected source and failed settlement still release the task's input custody.
    consume();
  }
}

serveWorkerTasks<NodeResult, NodeInput>(
  async (input, channel): Promise<NodeResult> => {
    const result = await run(input, channel);
    if (cell?.networkContentObserved) {
      result.networkContentObserved = true;
    }
    if (result.status !== "waiting") {
      cell = undefined;
    }
    return result;
  },
  { idleGc: false },
);
