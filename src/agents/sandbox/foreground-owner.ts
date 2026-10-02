import { randomUUID } from "node:crypto";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  runOutsideCommandProcessScope,
  withCommandProcessScope,
} from "../../process/exec-spawn.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  assertAdmittedRunForegroundRequest,
  readAdmittedRunOperatorAuthority,
  registerAdmittedRunCleanup,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { waitForExecScope } from "../bash-process-registry.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { NATIVE_SANDBOX_SETTLEMENT_MS, type NativeSandboxCustody } from "./container-engine.js";

const owners = new WeakMap<AdmittedRunContext, NativeSandboxCustody>();
const backends = new WeakMap<SandboxBackendHandle, NativeSandboxCustody>();

export function bindForegroundSandboxBackend(
  backend: SandboxBackendHandle,
  custody: NativeSandboxCustody,
) {
  custody.assertCurrent();
  backends.set(backend, custody);
}

export function readForegroundSandboxCustody(backend: SandboxBackendHandle | undefined) {
  return backend ? backends.get(backend) : undefined;
}

/** One admitted turn owns every allocation and the transport processes that can reach it. */
export function acquireForegroundSandboxCustody(
  context: AdmittedRunContext,
  signal?: AbortSignal,
): NativeSandboxCustody {
  const existing = owners.get(context);
  if (existing) {
    existing.assertCurrent();
    return existing;
  }
  const assertAdmitted = resolveAdmittedRunActiveAssertion(context);
  if (!assertAdmitted) {
    throw new Error("Foreground execution requires an active admitted run.");
  }
  assertAdmittedRunForegroundRequest(context);
  const controller = new AbortController();
  const source = readAdmittedRunOperatorAuthority(context);
  const sourceSignals = [signal, source?.signal].filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  );
  const executionSignal = AbortSignal.any([controller.signal, ...sourceSignals]);
  const runtimeKey = `foreground:${context.operationalRunInstance.runId}:${randomUUID()}`;
  const producers = new Set<Promise<unknown>>();
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const assertCurrent = () => {
    executionSignal.throwIfAborted();
    assertAdmitted();
    assertAdmittedRunForegroundRequest(context);
    source?.assertCurrent();
  };
  const assertCleanupConfirmed = () => {
    if (failures.length > 0) {
      throw new AggregateError(failures, "Foreground transport cleanup is unconfirmed");
    }
  };
  const close = () => {
    if (closing) {
      return closing;
    }
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled(producers);
      // Retire local producers before forgetting the native allocation. Namespace
      // termination cannot erase uncertainty about an escaped local transport.
      for (const result of await Promise.allSettled([
        cleanupScope(),
        waitForExecScope(runtimeKey),
      ])) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      for (const result of await Promise.allSettled(
        cleanups.map((cleanup) => cleanup("foreground-end")),
      )) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      for (const sourceSignal of sourceSignals) {
        sourceSignal.removeEventListener("abort", onAbort);
      }
      assertCleanupConfirmed();
    });
    controller.abort();
    return closing;
  };
  const onAbort = () => {
    // The admission finalizer joins this same result; record failure even if the
    // caller has already disconnected and cannot receive its terminal response.
    void close().catch(() => recordAgentCleanupFailure());
  };
  const custody: NativeSandboxCustody = {
    runtimeKey,
    runInstance: context.operationalRunInstance,
    signal: executionSignal,
    assertCurrent,
    assertCleanupConfirmed,
    registerCleanup(cleanup) {
      assertCurrent();
      cleanups.push(cleanup);
    },
    runProducer(run, options) {
      assertCurrent();
      const pending = Promise.resolve().then(() => {
        assertCurrent();
        const producerSignal = options?.settleAfterAbort
          ? AbortSignal.timeout(NATIVE_SANDBOX_SETTLEMENT_MS)
          : executionSignal;
        return runOutsideCommandProcessScope(() => withCommandProcessScope(run, producerSignal));
      });
      producers.add(pending);
      void pending.then(
        () => producers.delete(pending),
        (error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            failures.push(error);
          }
          producers.delete(pending);
        },
      );
      return pending;
    },
  };
  registerAdmittedRunCleanup(context, close);
  const cleanupScope = getProcessSupervisor().acquireScopeCleanup(runtimeKey, {
    processTree: "required-all",
  });
  owners.set(context, custody);
  for (const sourceSignal of sourceSignals) {
    sourceSignal.addEventListener("abort", onAbort, { once: true });
  }
  if (executionSignal.aborted) {
    onAbort();
  }
  assertCurrent();
  return custody;
}
