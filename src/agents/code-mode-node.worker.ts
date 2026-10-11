import { setImmediate } from "node:timers/promises";
import { types } from "node:util";
import { getHeapStatistics } from "node:v8";
import { createContext, Script, type Context } from "node:vm";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks, type WorkerTaskChannel } from "../infra/worker-task-server.js";
import { CODE_MODE_CONTROLLER_SOURCE } from "./code-mode-controller-source.js";
import {
  boundCodeModeError,
  captureCodeModeOutput,
  captureCodeModeValue,
  EMPTY_CODE_MODE_OUTPUT,
} from "./code-mode-json.js";
import { CodeModeNodeProgress } from "./code-mode-node-progress.js";
import {
  buildUserSource,
  normalizeSourceStack,
  USER_SOURCE_FILE,
  type SourceLocation,
} from "./code-mode-source-location.js";
import { prepareSource } from "./code-mode-source.js";
import type {
  CodeModeConfig,
  CodeModeNodeInput,
  CodeModeWorkerContinuation,
  CodeModeWorkerThreadResult,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-worker-types.js";
import { ToolInputError } from "./tool-input-error.js";

type NodeInput = CodeModeNodeInput;
type NodeResult = CodeModeWorkerThreadResult<undefined>;

type GuestOutcome = { ok: boolean; json: string };
type NodeCell = {
  context: Context;
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

const bridgeMethods = new Set<string>([
  "search",
  "describe",
  "callValue",
  "resultSave",
  "resultLoad",
  "resultDelete",
  "nodes",
  "yield",
  "namespace",
  "agentSpawn",
  "agentWait",
  "skillsList",
  "skillsSearch",
  "skillsRead",
  "sleep",
  "swarmNote",
]);

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
      const stringify = JSON.stringify;
      const string = String;
      const encodeError = (error) => {
        const bridgeCode = __openclawBridgeFailureCode(error) ?? null;
        const diagnostic = (read, fallback) => {
          try { return read(); } catch { return fallback; }
        };
        // Guest error properties may throw; recorded bridge identity must still reach finish.
        const stack = diagnostic(() => error?.stack, "");
        // Provenance records contain primitives and never inherit guest toJSON hooks.
        return stringify({
          __proto__: null,
          bridgeCode,
          name: diagnostic(() => string(error?.name ?? "Error"), "Error"),
          message: diagnostic(() => string(error?.message ?? error), "Error"),
          stack: typeof stack === "string" ? stack : "",
        });
      };
      Object.defineProperties(globalThis, {
        __openclawNodeEncodeError: { value: encodeError },
        __openclawNodeObserveResult: { value: (result) => {
          result.then(value => finish(true, value), error => finish(false, encodeError(error)));
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
const outputScript = compileController("__openclawTakeOutputJson()");
const observeResultScript = compileController("__openclawNodeObserveResult(__openclawResult)");
const rejectionScript = compileController(
  `(() => {
    const error = __openclawNodeRejection;
    delete globalThis.__openclawNodeRejection;
    return __openclawNodeEncodeError(error);
  })()`,
);

function evaluate(current: NodeCell, script: Script): unknown {
  const remaining = current.deadline - performance.now();
  if (remaining <= 0) {
    throw new Error("code mode timeout exceeded");
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

function guestError(error: unknown, location: SourceLocation): string {
  if (!types.isNativeError(error)) {
    return String(error);
  }
  const frames = sourceFrames(error.stack, location);
  if (frames.length === 0 && error.name === "SyntaxError") {
    const syntax = /^openclaw-code-mode:user\.js:(\d+)\n[^\n]*\n([ \t]*)\^/u.exec(
      error.stack ?? "",
    );
    const line = syntax?.[1];
    const prefix = syntax?.[2];
    if (line !== undefined && prefix !== undefined) {
      frames.push(
        ...sourceFrames(`    at ${USER_SOURCE_FILE}:${line}:${prefix.length + 1}`, location),
      );
    }
  }
  return [`${error.name}: ${error.message}`, ...frames].join("\n");
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
    throw new Error("code mode timeout exceeded");
  }
  const program = buildUserSource(source, input.prelude, "utf16");
  const context = createContext(Object.create(null), { microtaskMode: "afterEvaluate" });
  const current: NodeCell = {
    context,
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

function takeOutput(current: NodeCell): unknown[] {
  const json = evaluate(current, outputScript);
  // SAFETY: The shared controller serializes its private output array before crossing this boundary.
  return JSON.parse(String(json)) as unknown[];
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
    return { code: "invalid_input", error: "code mode module access is disabled." };
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
  failurePhase?: "bridge",
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
  let output: unknown[] = [];
  let consumed = channel?.consumeInput;
  const config = input.config;
  const startedAt = performance.now();
  const progress = new CodeModeNodeProgress(input.progress);
  try {
    const current =
      input.kind === "exec"
        ? createCell(input, prepareSource(input.source), startedAt, progress, consumed)
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
    } else {
      consumed = undefined;
    }
    for (;;) {
      consumed?.();
      consumed = undefined;
      const admissionError = current.admissionError ?? evaluate(current, drainScript);
      if (admissionError !== undefined && typeof admissionError !== "string") {
        throw new Error("invalid code mode admission error");
      }
      if (admissionError) {
        throw new ToolInputError(admissionError);
      }
      // Native rejection/handled notifications arrive at the end of the turn.
      await setImmediate();
      output = takeOutput(current);
      const pending = !current.outcome;
      if (pending && current.pendingRequests.length === 0) {
        throw new Error("code mode promise is pending without host work");
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
          output: captureCodeModeOutput(output, config.maxOutputBytes),
          // Worker-wide V8 allocation is diagnostic, not a per-context memory bound.
          memoryUsedBytes: getHeapStatistics().used_heap_size,
          ...(current.networkContentObserved ? { networkContentObserved: true as const } : {}),
        };
        if (!channel || !input.inlineHost) {
          return { status: "waiting", ...boundary, continuation: undefined };
        }
        const response = await channel.request({ status: "boundary", ...boundary });
        output = [];
        consumed = response.consumed;
        // SAFETY: The task-bound host sends the shared typed continuation protocol.
        const command = response.input as CodeModeWorkerContinuation;
        if (command.kind === "checkpoint") {
          consumed();
          consumed = undefined;
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
          throw new Error("code mode timeout exceeded");
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
        return failed(
          failure.code,
          boundCodeModeError(failure.error, config.maxOutputBytes),
          captureCodeModeOutput(output, config.maxOutputBytes),
          failure.failurePhase,
        );
      }
      return {
        status: "completed",
        output: captureCodeModeOutput(output, config.maxOutputBytes),
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
    const timeout = types.isNativeError(error) && error.message === "code mode timeout exceeded";
    if (cell && output.length === 0 && !timeout) {
      try {
        output = takeOutput(cell);
      } catch {
        /* An exhausted guest cannot serialize more output. */
      }
    }
    return failed(
      timeout ? "timeout" : error instanceof ToolInputError ? "invalid_input" : "internal_error",
      boundCodeModeError(
        timeout
          ? "code mode timeout exceeded"
          : cell
            ? guestError(error, cell.location)
            : error instanceof Error
              ? error.message
              : String(error),
        config.maxOutputBytes,
      ),
      timeout ? progress.output() : captureCodeModeOutput(output, config.maxOutputBytes),
    );
  }
}

serveWorkerTasks(async (input, channel): Promise<NodeResult> => {
  if (
    !isRecord(input) ||
    !isRecord(input.config) ||
    (input.kind !== "exec" && input.kind !== "resume")
  ) {
    return failed("invalid_input", "invalid code mode worker input");
  }
  // SAFETY: The executor host supplies normalized start/resume inputs to its private worker.
  const result = await run(input as NodeInput, channel);
  if (cell?.networkContentObserved) {
    result.networkContentObserved = true;
  }
  if (result.status !== "waiting") {
    cell = undefined;
  }
  return result;
});
