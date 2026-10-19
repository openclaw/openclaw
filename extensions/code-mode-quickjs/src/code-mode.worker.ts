import { threadId } from "node:worker_threads";
import {
  CODE_MODE_CONTROLLER_SOURCE,
  boundCodeModeError,
  captureCodeModeOutput,
  captureCodeModeValue,
  buildUserSource,
  SOURCE_LOCATION_KEY,
  USER_SOURCE_FILE,
  normalizeSourceStack,
  prepareSource,
  ToolInputError,
  type CodeModeConfig,
  type CodeModeWorkerContinuation,
  type CodeModeVmResult,
  type CodeModeWorkerThreadResult as SharedWorkerThreadResult,
  type PendingBridgeRequest,
  type SettledBridgeRequest,
  type SourceLocation,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { serveWorkerTasks, type WorkerTaskChannel } from "openclaw/plugin-sdk/worker-task-server";
import {
  EvalFlags,
  JSException,
  MAX_STACK_SIZE,
  QuickJS,
  type JSValueHandle,
  type Snapshot,
} from "quickjs-wasi";
import { readSourceLocation } from "./source-location.js";
import type { QuickJsWorkerPayload as CodeModeWorkerPayload } from "./worker-types.js";

type CodeModeWorkerResult = CodeModeVmResult<Snapshot>;
type CodeModeWorkerThreadResult = SharedWorkerThreadResult<Snapshot>;
type CodeModeFailure = Extract<CodeModeWorkerResult, { status: "failed" }>;

class CodeModeWorkerFailure extends Error {
  constructor(
    readonly code: CodeModeFailure["code"],
    message: string,
    readonly failurePhase: CodeModeFailure["failurePhase"],
  ) {
    super(message);
    this.name = "CodeModeWorkerFailure";
  }
}

function notifyWorkerFailure(
  channel: WorkerTaskChannel | undefined,
  error: unknown,
  failurePhase: CodeModeFailure["failurePhase"],
): void {
  channel?.notify({
    status: "failure",
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    failurePhase,
  });
}

type VmRun = {
  vm: QuickJS;
  didTimeout: () => boolean;
  setBudget: (timeoutMs: number) => void;
  pauseBudget: () => void;
};

// Workers are reusable; every VM owns its own bridge state, including failures
// and cancellations, so a later session cannot inherit a previous run's state.
type BridgeState = {
  pendingRequests: PendingBridgeRequest[];
  canceledRequestIds: string[];
  replies?: SettledBridgeRequest[];
  replyIndex: number;
  admissionFailure?: CodeModeWorkerFailure;
  networkContentObserved?: true;
};

// QuickJS error stacks are backtrace frames only ("    at file:line:col"), with
// no leading "Name: message" header like V8. Returning .stack alone therefore
// dropped the actual cause, surfacing failures to the model as a bare location
// (e.g. "at openclaw-code-mode:user.js:2:37"). Lead with name+message so the
// model can self-correct, and keep the frames for location.
function formatQuickJsError(
  name: string,
  message: string,
  stack: string | undefined,
  location?: SourceLocation,
): string {
  const header = message ? `${name}: ${message}` : name;
  const sourceStack = normalizeSourceStack(stack, location);
  if (!sourceStack || sourceStack.split(/\r?\n/, 1)[0] === header) {
    return header;
  }
  return `${header}\n${sourceStack}`;
}

function errorMessage(error: unknown, location?: SourceLocation): string {
  if (error instanceof JSException) {
    return formatQuickJsError(error.name, error.message, error.stack, location);
  }
  return error instanceof Error ? error.message || String(error) : String(error);
}

function trackPromiseRejection(
  promise: JSValueHandle,
  reason: JSValueHandle,
  handled: boolean,
): void {
  const vm = promise.vm;
  vm.global
    .getProp("__openclawTrackRejection")
    .consume((track) =>
      vm.callFunction(track, vm.undefined, promise, reason, handled ? vm.true : vm.false).dispose(),
    );
}

function createHostRequestHandler(params: {
  vm: QuickJS;
  bridge: BridgeState;
  config: CodeModeConfig;
}): (
  this: JSValueHandle,
  method: JSValueHandle,
  argsJson: JSValueHandle,
  bridgeId?: JSValueHandle,
  callStack?: JSValueHandle,
) => JSValueHandle {
  return (methodHandle, argsHandle, bridgeIdHandle, callStackHandle) => {
    if (params.bridge.pendingRequests.length >= params.config.maxPendingToolCalls) {
      params.bridge.admissionFailure ??= new CodeModeWorkerFailure(
        "invalid_input",
        "too many pending code mode tool calls",
        "input",
      );
      throw params.bridge.admissionFailure;
    }
    const method = methodHandle.toString();
    if (
      method !== "search" &&
      method !== "describe" &&
      method !== "callValue" &&
      method !== "resultSave" &&
      method !== "resultLoad" &&
      method !== "resultDelete" &&
      method !== "nodes" &&
      method !== "yield" &&
      method !== "namespace" &&
      method !== "agentSpawn" &&
      method !== "agentWait" &&
      method !== "skillsList" &&
      method !== "skillsSearch" &&
      method !== "skillsRead" &&
      method !== "sleep" &&
      method !== "swarmNote"
    ) {
      throw new Error("unsupported code mode bridge method");
    }
    const args: unknown = JSON.parse(argsHandle.toString());
    if (!Array.isArray(args)) {
      throw new Error("invalid code mode bridge arguments: expected an array");
    }
    // Snapshotted method counters keep launch identity independent of unrelated bridge traffic.
    // Snapshots are process-local, so every resumable guest comes from the ID-aware source above.
    const id = bridgeIdHandle?.toString();
    if (!id?.startsWith(`bridge:${method}:`) || !/^bridge:[A-Za-z]+:[1-9]\d*$/u.test(id)) {
      throw new Error("invalid code mode bridge id");
    }
    if (params.bridge.pendingRequests.some((request) => request.id === id)) {
      throw new Error("duplicate code mode bridge id");
    }
    // The guest receives only an opaque id. Host-side tool execution and policy
    // happen after the worker returns a waiting snapshot.
    params.bridge.pendingRequests.push({
      id,
      method,
      args,
    });
    // Return only diagnostic guest coordinates, not host frames or dispatch authority.
    const stack = callStackHandle?.isString ? callStackHandle.toString().slice(0, 8192) : "";
    return params.vm.newString(normalizeSourceStack(stack, readSourceLocation(params.vm)) ?? "");
  };
}

function createHostCancelRequestHandler(params: {
  vm: QuickJS;
  bridge: BridgeState;
}): (this: JSValueHandle, id: JSValueHandle) => JSValueHandle {
  return (idHandle) => {
    const id = idHandle.toString();
    const index = params.bridge.pendingRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      // Return the cancellation to the parent owner as well as removing it
      // locally; restored requests may already have a live host operation.
      params.bridge.pendingRequests.splice(index, 1);
      params.bridge.canceledRequestIds.push(id);
    }
    return params.vm.undefined;
  };
}

async function createVm(input: CodeModeWorkerPayload, bridge: BridgeState): Promise<VmRun> {
  const startedAt = performance.now();
  let deadlineMs = startedAt + input.config.timeoutMs;
  let timedOut = false;
  let paused = false;
  const deadlineReached = () => !paused && performance.now() >= deadlineMs;
  const options = {
    wasm: input.wasmModule,
    // Pinned pure-data extensions share the sandbox heap and must be supplied
    // on restore so retained encoder/decoder instances keep their native methods.
    extensions: input.wasmExtensions,
    memoryLimit: input.config.memoryLimitBytes,
    maxStackSize: MAX_STACK_SIZE,
    timezoneOffset: 0,
    onUnhandledRejection: trackPromiseRejection,
    interruptHandler: () => {
      timedOut = deadlineReached();
      return timedOut;
    },
  };
  const vm = await (
    input.kind === "resume" ? QuickJS.restore(input.continuation, options) : QuickJS.create(options)
  ).catch((error: unknown) => {
    throw timedOut
      ? new CodeModeWorkerFailure("timeout", "code mode timeout exceeded", "host")
      : error;
  });
  try {
    if (input.kind === "resume") {
      // Restore owns an independent WASM heap; all incoming aliases share this snapshot.
      input.continuation.memory = new Uint8Array();
    }
    const callbacks = [
      ["__openclawHostRequest", createHostRequestHandler({ vm, bridge, config: input.config })],
      ["__openclawHostCancelRequest", createHostCancelRequestHandler({ vm, bridge })],
      [
        "__openclawHostTakeBridgeReply",
        () => {
          const request = bridge.replies?.[bridge.replyIndex];
          if (!request) {
            return vm.undefined;
          }
          bridge.replyIndex++;
          // Own data properties: guest Object.prototype accessors must not
          // intercept or replace host reply fields.
          const reply = vm.newObject();
          try {
            using id = vm.newString(request.id);
            using json = vm.newString(request.json);
            vm.defineProp(reply, "id", id);
            vm.defineProp(reply, "ok", request.ok ? vm.true : vm.false);
            vm.defineProp(reply, "json", json);
          } catch (error) {
            reply.dispose();
            throw error;
          } finally {
            request.json = "";
          }
          return reply;
        },
      ],
      [
        "__openclawHostObserveNetworkContent",
        () => {
          bridge.networkContentObserved = true;
          return vm.undefined;
        },
      ],
    ] as const;
    for (const [name, callback] of callbacks) {
      if (input.kind === "resume") {
        // The snapshot owns the original function identities. Rebind callbacks
        // by name without recreating globals the controller deliberately hides.
        vm.registerHostCallback(name, callback);
      } else {
        vm.newFunction(name, callback).consume((handle) => vm.global.setProp(name, handle));
      }
    }
    if (input.kind === "exec") {
      for (const [name, value] of [
        ["__openclawCatalog", input.catalog],
        ["__openclawNamespaces", input.namespaces],
        ["__openclawApiFiles", input.apiFiles ?? []],
        ["__openclawSwarmEnabled", input.swarmEnabled === true],
        ["__openclawMaxPendingToolCalls", input.config.maxPendingToolCalls],
      ] as const) {
        vm.hostToHandle(value).consume((handle) => vm.global.setProp(name, handle));
      }
      vm.evalCode(CODE_MODE_CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
    }
    return {
      vm,
      didTimeout: () => timedOut || deadlineReached(),
      pauseBudget: () => {
        timedOut ||= deadlineReached();
        paused = true;
      },
      setBudget: (timeoutMs) => {
        paused = false;
        timedOut = false;
        deadlineMs = performance.now() + timeoutMs;
      },
    };
  } catch (error) {
    vm.dispose();
    throw timedOut
      ? new CodeModeWorkerFailure("timeout", "code mode timeout exceeded", "host")
      : error;
  }
}

function takeOutput(vm: QuickJS): unknown[] {
  return vm.global.getProp("__openclawTakeOutputJson").consume((take) =>
    vm.callFunction(take, vm.undefined).consume((output) => {
      const parsed: unknown = JSON.parse(output.toString());
      return Array.isArray(parsed) ? parsed : [];
    }),
  );
}

function takeOutputSafely(vm: QuickJS): unknown[] {
  try {
    return takeOutput(vm);
  } catch {
    // A failed guest may also break output extraction; preserve its original failure.
    return [];
  }
}

function captureWorkerResult(
  result: CodeModeWorkerResult,
  config: CodeModeConfig,
  retainFinalValue = false,
): CodeModeWorkerThreadResult {
  const output = captureCodeModeOutput(result.output, config.maxOutputBytes);
  if (result.status === "completed") {
    return {
      ...result,
      output,
      value: captureCodeModeValue(
        result.value,
        config.maxOutputBytes,
        retainFinalValue
          ? Math.min(config.memoryLimitBytes, config.maxSnapshotBytes)
          : config.maxOutputBytes,
      ),
    };
  }
  return result.status === "failed"
    ? { ...result, output, error: boundCodeModeError(result.error, config.maxOutputBytes) }
    : { ...result, output };
}

function failedWorkerResult(
  code: CodeModeFailure["code"],
  error: string,
  output: unknown[] = [],
  failurePhase: CodeModeFailure["failurePhase"] = "host",
): CodeModeFailure {
  return {
    status: "failed",
    code,
    error,
    failurePhase,
    bridgeDispatchStarted: false,
    output,
  };
}

function workerFailureResult(
  error: unknown,
  output: unknown[] = [],
  location?: SourceLocation,
): CodeModeFailure {
  const failure = error instanceof CodeModeWorkerFailure ? error : undefined;
  const inputError = error instanceof ToolInputError;
  return failedWorkerResult(
    failure?.code ?? (inputError ? "invalid_input" : "internal_error"),
    errorMessage(error, location),
    output,
    failure?.failurePhase ?? (inputError ? "input" : "host"),
  );
}

async function readCompletedResult(vm: QuickJS, resultHandle: JSValueHandle): Promise<unknown> {
  const settled = await vm.resolvePromise(resultHandle);
  if ("error" in settled) {
    return settled.error.consume((error) => {
      // vm.dump rebuilds a host Error carrying the QuickJS name/message/stack;
      // format it like the synchronous path so async rejections keep their cause
      // and location instead of collapsing to the bare message.
      const dumped = vm.dump(error);
      const bridgeCode = vm.global.getProp("__openclawBridgeFailureCode").consume((read) =>
        vm
          .callFunction(read, vm.undefined, error)
          .consume((value): "invalid_input" | "internal_error" | undefined => {
            const code: unknown = vm.dump(value);
            return code === "invalid_input" || code === "internal_error" ? code : undefined;
          }),
      );
      // Node module globals are deliberately absent from the WASI guest. Keep
      // aliases fail-closed at that runtime boundary rather than guessing source
      // provenance or installing a host-backed loader.
      if (
        bridgeCode === undefined &&
        dumped instanceof Error &&
        dumped.name === "ReferenceError" &&
        /^(?:require|module|process) is not defined$/u.test(dumped.message)
      ) {
        throw new CodeModeWorkerFailure(
          "invalid_input",
          "code mode module access is disabled.",
          "input",
        );
      }
      const text =
        dumped instanceof Error
          ? formatQuickJsError(dumped.name, dumped.message, dumped.stack, readSourceLocation(vm))
          : errorMessage(dumped);
      throw new CodeModeWorkerFailure(
        bridgeCode ?? "internal_error",
        text,
        bridgeCode === undefined ? "guest" : "bridge",
      );
    });
  }
  return settled.value.consume((value) => JSON.parse(value.toString()));
}

function waitingResult(params: {
  vm: QuickJS;
  bridge: BridgeState;
  settlementMode: Extract<CodeModeWorkerResult, { status: "waiting" }>["settlementMode"];
  output: unknown[];
  config: CodeModeConfig;
}): CodeModeWorkerResult {
  const snapshot = params.vm.snapshot();
  // Preserve the encoded-size cap, but serialize only metadata: the snapshot
  // already owns transferable memory, so the storage codec would copy it again.
  const metadata = QuickJS.serializeSnapshot({ ...snapshot, memory: new Uint8Array() });
  if (snapshot.memory.byteLength + metadata.byteLength > params.config.maxSnapshotBytes) {
    throw new CodeModeWorkerFailure(
      "snapshot_limit_exceeded",
      "code mode snapshot limit exceeded",
      "guest",
    );
  }
  return {
    status: "waiting",
    continuation: snapshot,
    pendingRequests: params.bridge.pendingRequests,
    canceledRequestIds: params.bridge.canceledRequestIds,
    settlementMode: params.settlementMode,
    output: params.output,
  };
}

async function runVmExecution(params: {
  vm: QuickJS;
  didTimeout: () => boolean;
  bridge: BridgeState;
  config: CodeModeConfig;
  prepare: () => void;
  maxTimeoutMs: number;
  setBudget: (timeoutMs: number) => void;
  pauseBudget: () => void;
  channel?: WorkerTaskChannel;
}): Promise<CodeModeWorkerResult> {
  let output: unknown[] = [];
  let prepare = params.prepare;
  let consumed = params.channel?.consumeInput;
  try {
    for (;;) {
      prepare();
      consumed?.();
      consumed = undefined;
      params.vm.executePendingJobs();
      if (params.bridge.admissionFailure) {
        throw params.bridge.admissionFailure;
      }
      const admissionError = params.vm.global
        .getProp("__openclawAdmissionError")
        .consume((read) =>
          params.vm
            .callFunction(read, params.vm.undefined)
            .consume((error) => (error.isString ? error.toString() : undefined)),
        );
      if (admissionError) {
        throw new CodeModeWorkerFailure("invalid_input", admissionError, "input");
      }
      params.vm.global
        .getProp("__openclawDrainQueuedRequests")
        .consume((drain) => params.vm.callFunction(drain, params.vm.undefined).dispose());
      output = takeOutput(params.vm);
      const resultHandle = params.vm.global.getProp("__openclawResult");
      try {
        const promisePending = resultHandle.isPromise && resultHandle.promiseState === 0;
        if (promisePending && params.bridge.pendingRequests.length === 0) {
          throw new ToolInputError("code mode promise is pending without host work");
        }
        const requiredPendingRequestIds = params.bridge.pendingRequests.map(
          (request) => request.id,
        );
        if (promisePending || requiredPendingRequestIds.length > 0) {
          // Native await does not expose Promise ownership. Every dispatched
          // call remains required, including detached calls and race branches.
          const settlementMode = promisePending
            ? { kind: "awaiting" as const }
            : { kind: "draining" as const, requiredRequestIds: requiredPendingRequestIds };
          if (params.channel) {
            // No guest code runs during this host wait. The host owner chooses
            // the remaining shared budget (and owns approval-time pauses).
            params.pauseBudget();
            const response = await params.channel.request({
              status: "boundary",
              ...(params.bridge.networkContentObserved
                ? { networkContentObserved: true as const }
                : {}),
              pendingRequests: params.bridge.pendingRequests,
              canceledRequestIds: params.bridge.canceledRequestIds,
              settlementMode,
              output: captureCodeModeOutput(output, params.config.maxOutputBytes),
              memoryUsedBytes: params.vm.getMemoryUsage().memoryUsedSize,
            });
            // Output already crossed to the owner. Do not emit it again on parking/failure.
            output = [];
            consumed = response.consumed;
            // SAFETY: The task-bound host returns only the typed continuation command.
            const command = response.input as CodeModeWorkerContinuation;
            if (command.kind === "continue") {
              if (
                !Number.isFinite(command.timeoutMs) ||
                command.timeoutMs <= 0 ||
                command.timeoutMs > params.maxTimeoutMs
              ) {
                throw new Error("invalid code mode continuation budget");
              }
              params.setBudget(command.timeoutMs);
              params.bridge.pendingRequests = command.pendingRequests;
              params.bridge.canceledRequestIds = [];
              prepare = () => settleRequests(params.vm, params.bridge, command.settledRequests);
              continue;
            }
            if (command.kind !== "checkpoint") {
              throw new Error("invalid code mode continuation");
            }
            // This control-only command has no reply input to inject. Failed
            // continuations above instead retain ownership until termination.
            consumed();
            consumed = undefined;
          }
          return waitingResult({
            vm: params.vm,
            bridge: params.bridge,
            settlementMode,
            output,
            config: params.config,
          });
        }
        const value = await readCompletedResult(params.vm, resultHandle);
        // Check only after all host work and microtasks settle. Catches attached
        // after an await (including a restored snapshot) still own their errors.
        using rejection = params.vm.global
          .getProp("__openclawUnhandledRejection")
          .consume((read) => params.vm.callFunction(read, params.vm.undefined));
        if (rejection.isPromise) {
          await readCompletedResult(params.vm, rejection);
        }
        return { status: "completed", value, output };
      } finally {
        resultHandle.dispose();
      }
    }
  } catch (error) {
    const timedOut = params.didTimeout();
    const failureOutput = output.length > 0 ? output : takeOutputSafely(params.vm);
    const result = timedOut
      ? failedWorkerResult("timeout", "code mode timeout exceeded", failureOutput, "guest")
      : workerFailureResult(error, failureOutput, readSourceLocation(params.vm));
    notifyWorkerFailure(params.channel, error, result.failurePhase);
    return result;
  } finally {
    params.vm.dispose();
    // An unconsumed input receives no receipt: the pool must terminate the
    // worker before releasing it, rather than infer consumption from VM disposal.
  }
}

function settleRequests(vm: QuickJS, bridge: BridgeState, requests: SettledBridgeRequest[]): void {
  bridge.replies = requests;
  bridge.replyIndex = 0;
  try {
    vm.global
      .getProp("__openclawSettleBridge")
      .consume((settle) => vm.callFunction(settle, vm.undefined).dispose());
  } finally {
    bridge.replies = undefined;
    bridge.replyIndex = 0;
    // No transport alias may retain replies after the consumption receipt,
    // including a failed conversion which closes the VM instead of resuming it.
    for (const request of requests) {
      request.json = "";
    }
    requests.length = 0;
  }
}

async function run(
  input: CodeModeWorkerPayload,
  channel?: WorkerTaskChannel,
): Promise<CodeModeWorkerResult> {
  const startedAt = performance.now();
  const source = input.kind === "exec" ? prepareSource(input.source) : "";
  const config = {
    ...input.config,
    timeoutMs: Math.min(
      input.config.timeoutMs - (performance.now() - startedAt),
      input.kind === "exec" ? (input.executionTimeoutMs ?? Infinity) : Infinity,
    ),
  };
  if (config.timeoutMs <= 0) {
    throw new CodeModeWorkerFailure("timeout", "code mode timeout exceeded", "host");
  }
  // Restored promises retain bridge IDs; unresolved siblings are not redispatched.
  const bridge: BridgeState = {
    pendingRequests: input.kind === "resume" ? [...(input.pendingRequests ?? [])] : [],
    canceledRequestIds: [],
    replyIndex: 0,
  };
  const { vm, didTimeout, setBudget, pauseBudget } = await createVm({ ...input, config }, bridge);
  const result = await runVmExecution({
    vm,
    didTimeout,
    setBudget,
    pauseBudget,
    channel,
    bridge,
    config,
    maxTimeoutMs: input.config.timeoutMs,
    prepare: () => {
      if (input.kind === "exec") {
        const program = buildUserSource(source, input.prelude);
        // Immutable guest state travels with the existing VM snapshot and its byte limit.
        vm.newString(JSON.stringify(program.location)).consume((location) =>
          vm.global.defineProp(SOURCE_LOCATION_KEY, location),
        );
        vm.evalCode(program.source, USER_SOURCE_FILE, EvalFlags.ASYNC).dispose();
        return;
      }
      settleRequests(vm, bridge, input.settledRequests);
    },
  });
  return bridge.networkContentObserved ? { ...result, networkContentObserved: true } : result;
}

async function main(
  input: CodeModeWorkerPayload,
  channel?: WorkerTaskChannel,
): Promise<CodeModeWorkerThreadResult> {
  channel?.notify({ status: "worker", workerId: `code-mode-quickjs:${threadId}` });
  const { config } = input;
  try {
    return captureWorkerResult(await run(input, channel), config, input.retainFinalValue === true);
  } catch (error) {
    const result = workerFailureResult(error);
    notifyWorkerFailure(channel, error, result.failurePhase);
    return captureWorkerResult(result, config);
  }
}

// SAFETY: Only the private typed executor submits tasks; guest code cannot post host messages.
serveWorkerTasks((input, channel) => main(input as CodeModeWorkerPayload, channel), {
  transferList: (result) =>
    // SAFETY: QuickJS.snapshot allocates a dedicated, transferable ArrayBuffer.
    result.status === "waiting" ? [result.continuation.memory.buffer as ArrayBuffer] : [],
});
