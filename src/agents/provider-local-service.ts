/** Manages optional local provider processes; request leases keep shared services alive. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  clampPositiveTimerTimeoutMs,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { sleepWithAbort } from "@openclaw/retry";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  forceKillChildProcessTree,
  isChildProcessTreeAlive,
  signalChildProcessTree,
  shouldDetachChildForProcessTree,
} from "../process/child-process-tree.js";
import { prepareOomScoreAdjustedSpawnPreservingExecEnv as prepareLocalServiceSpawn } from "../process/linux-oom-score.js";
import {
  appendLocalServiceOutputTail,
  formatLocalServiceDiagnosticTail,
  formatLocalServiceExit,
  type LocalServiceDiagnostics,
  type LocalServiceExit,
} from "./provider-local-service-diagnostics.js";
import { getModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import type {
  AcquireConfiguredProviderLocalService,
  ProviderLocalServiceLease,
  ProviderLocalServiceTarget,
} from "./provider-local-service-target.js";
import { resolveConfiguredProviderLocalServiceTarget } from "./provider-local-service-target.js";
import { setManagedProviderLocalServicesActive } from "./provider-runtime-lifecycle.js";
import { unwrapHeadersInitSentinelsForProviderEgress } from "./provider-secret-egress.js";

const log = createSubsystemLogger("provider-local-service");
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 250;
const PROCESS_TREE_EXIT_POLL_MS = 25;

const MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL = Symbol.for("openclaw.modelProviderLocalService");

type ModelWithProviderLocalService = {
  [MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL]?: ModelProviderLocalServiceConfig;
};

type ManagedLocalService = {
  process?: ChildProcess;
  processStop?: { child: ChildProcess; promise?: Promise<void> };
  stopping?: { promise?: Promise<void> };
  starting?: Promise<void>;
  startupAbort?: AbortController;
  active: number;
  idleTimer?: NodeJS.Timeout;
  lastExit?: LocalServiceExit;
  diagnostics?: LocalServiceDiagnostics;
};

const services = new Map<string, ManagedLocalService>();
let exitHandlerInstalled = false;

/** Bind local-service acquisition to a host-owned config snapshot. */
export function createConfiguredProviderLocalServiceAcquirer(
  getConfig: () => OpenClawConfig,
): AcquireConfiguredProviderLocalService {
  return async (target, signal) => {
    const resolved = resolveConfiguredProviderLocalServiceTarget(getConfig(), target);
    return resolved ? await ensureProviderLocalService(resolved, signal) : undefined;
  };
}

/** Attach local-service startup metadata to a model without mutating the original object. */
export function attachModelProviderLocalService<TModel extends object>(
  model: TModel,
  service: ModelProviderLocalServiceConfig | undefined,
): TModel {
  if (!service) {
    return model;
  }
  const next = { ...model } as TModel & ModelWithProviderLocalService;
  next[MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL] = service;
  return next;
}

/** Read local-service startup metadata attached to a model. */
export function getModelProviderLocalService(
  model: object,
): ModelProviderLocalServiceConfig | undefined {
  return (model as ModelWithProviderLocalService)[MODEL_PROVIDER_LOCAL_SERVICE_SYMBOL];
}

/** Ensure a model's local provider service is healthy and return a lease. */
export async function ensureModelProviderLocalService(
  model: Model,
  probeHeaders?: HeadersInit,
  signal?: AbortSignal | null,
): Promise<ProviderLocalServiceLease | undefined> {
  const service = getModelProviderLocalService(model);
  return await ensureProviderLocalService(
    {
      providerId: model.provider,
      baseUrl: model.baseUrl,
      headers: buildHealthProbeHeaders((model as { headers?: HeadersInit }).headers, probeHeaders),
      service,
      reconcile: getModelProviderLocalServiceReconciler(model),
    },
    signal,
  );
}

/** Ensure a provider endpoint's local service is healthy and return a request lease. */
export async function ensureProviderLocalService(
  target: ProviderLocalServiceTarget,
  signal?: AbortSignal | null,
): Promise<ProviderLocalServiceLease | undefined> {
  const lease = await acquireProviderLocalService(target, signal);
  if (!lease || !target.reconcile) {
    return lease;
  }
  try {
    await target.reconcile({ baseUrl: target.baseUrl, signal: signal ?? undefined });
    throwIfAborted(signal);
  } catch (error) {
    lease.release();
    throw error;
  }
  return lease;
}

async function acquireProviderLocalService(
  target: ProviderLocalServiceTarget,
  signal?: AbortSignal | null,
): Promise<ProviderLocalServiceLease | undefined> {
  const service = target.service;
  if (!service) {
    return undefined;
  }
  throwIfAborted(signal);

  validateLocalServiceConfig(service, target.providerId);
  const healthUrl = resolveHealthUrl(service, target.baseUrl);
  const healthHeaders = buildHealthProbeHeaders(target.headers, undefined);
  const key = localServiceKey(target.providerId, service, healthUrl);
  installExitHandler();
  let current = services.get(key);
  while (current?.stopping) {
    await waitForAbort(stopManagedService(key, current, "reacquire"), signal);
    throwIfAborted(signal);
    current = services.get(key);
  }
  const managed = current ?? { active: 0 };
  services.set(key, managed);
  setManagedProviderLocalServicesActive(true);
  clearIdleTimer(managed);
  managed.active += 1;

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    managed.active = Math.max(0, managed.active - 1);
    scheduleIdleStop(key, managed, service);
  };

  try {
    target.onReadinessWait?.(true);
    try {
      const currentProcess = managed.process;
      const healthy =
        currentProcess && !managed.processStop && !hasLocalServiceProcessExited(currentProcess)
          ? await probeHealth(healthUrl, healthHeaders, signal)
          : false;
      assertCurrentServiceAcquisition(key, managed, signal);
      if (
        healthy &&
        currentProcess &&
        managed.process === currentProcess &&
        !managed.processStop &&
        !hasLocalServiceProcessExited(currentProcess)
      ) {
        return { release };
      }
      if (!managed.starting) {
        // Concurrent callers share one startup promise for the same service key.
        const startupAbort = new AbortController();
        managed.startupAbort = startupAbort;
        managed.starting = startAndWaitForLocalService({
          key,
          provider: target.providerId,
          service,
          healthUrl,
          healthHeaders,
          managed,
          signal: startupAbort.signal,
        }).finally(() => {
          managed.starting = undefined;
          if (managed.startupAbort === startupAbort) {
            managed.startupAbort = undefined;
          }
        });
      }
      await waitForAbort(managed.starting, signal);
      assertCurrentServiceAcquisition(key, managed, signal);
      const ready =
        !managed.processStop &&
        ((managed.process && !hasLocalServiceProcessExited(managed.process)) ||
          (await probeHealth(healthUrl, healthHeaders, signal)));
      assertCurrentServiceAcquisition(key, managed, signal);
      if (ready && !managed.processStop) {
        return { release };
      }
      release();
      return undefined;
    } finally {
      target.onReadinessWait?.(false);
    }
  } catch (error) {
    const abortingStartup = isAbortForSignal(error, signal) && Boolean(managed.starting);
    release();
    if (isAbortForSignal(error, signal)) {
      if (abortingStartup && managed.active === 0) {
        managed.startupAbort?.abort(toAbortError(signal));
        await stopManagedService(key, managed, "startup-aborted");
      }
    } else {
      await stopManagedService(key, managed, "startup-failed");
    }
    throw error;
  }
}

function assertCurrentServiceAcquisition(
  key: string,
  managed: ManagedLocalService,
  signal?: AbortSignal | null,
): void {
  throwIfAborted(signal);
  if (managed.stopping || services.get(key) !== managed) {
    throw new Error("Local model service stopped during acquisition");
  }
}

/** Stop all managed local services owned by this process. */
export async function stopManagedProviderLocalServices(): Promise<void> {
  await Promise.all(
    [...services].map(([key, managed]) => stopManagedService(key, managed, "host-shutdown")),
  );
}

/** Return bounded local-service state for focused lifecycle tests. */
export function getManagedProviderLocalServiceDiagnosticsForTest(): LocalServiceDiagnostics[] {
  return structuredClone(
    [...services.values()]
      .map((managed) => managed.diagnostics)
      .filter((value): value is LocalServiceDiagnostics => value !== undefined),
  );
}

function validateLocalServiceConfig(service: ModelProviderLocalServiceConfig, provider: string) {
  if (!path.isAbsolute(service.command)) {
    throw new Error(`models.providers.${provider}.localService.command must be an absolute path`);
  }
}

function resolveHealthUrl(service: ModelProviderLocalServiceConfig, baseUrl: string): string {
  return service.healthUrl?.trim() || `${baseUrl.replace(/\/+$/, "")}/models`;
}

function localServiceKey(
  provider: string,
  service: ModelProviderLocalServiceConfig,
  healthUrl: string,
): string {
  return JSON.stringify({
    provider,
    command: service.command,
    args: service.args ?? [],
    cwd: service.cwd ?? "",
    envHash: hashStringRecord(service.env),
    healthUrl,
  });
}

function hashStringRecord(record: Record<string, string> | undefined): string {
  const sorted = Object.entries(record ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function buildHealthProbeHeaders(
  providerHeaders: HeadersInit | undefined,
  requestHeaders: HeadersInit | undefined,
): Headers | undefined {
  const headers = new Headers();
  const appendHeaders = (input: HeadersInit | undefined) => {
    if (!input) {
      return;
    }
    for (const [key, value] of new Headers(input)) {
      if (value.trim().length > 0 && value.trim().toLowerCase() !== "null") {
        headers.set(key, value);
      }
    }
  };
  appendHeaders(providerHeaders);
  appendHeaders(requestHeaders);
  return [...headers].length > 0 ? headers : undefined;
}

async function probeHealth(
  url: string,
  headers: HeadersInit | undefined,
  signal?: AbortSignal | null,
): Promise<boolean> {
  throwIfAborted(signal);
  // Only the actual health request may materialize retained sentinel headers.
  const egressHeaders = unwrapHeadersInitSentinelsForProviderEgress(
    headers,
    "to probe local model provider health",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = () => controller.abort(toAbortError(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  let response: Response | undefined;
  try {
    response = await fetch(url, { headers: egressHeaders, signal: controller.signal });
    return response.ok;
  } catch {
    if (signal?.aborted) {
      throw toAbortError(signal);
    }
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await response?.body?.cancel?.().catch(() => undefined);
  }
}

async function startAndWaitForLocalService(params: {
  key: string;
  provider: string;
  service: ModelProviderLocalServiceConfig;
  healthUrl: string;
  healthHeaders: HeadersInit | undefined;
  managed: ManagedLocalService;
  signal: AbortSignal;
}): Promise<void> {
  const { key, provider, service, healthUrl, healthHeaders, managed, signal } = params;
  const healthy = await probeHealth(healthUrl, healthHeaders, signal);
  assertCurrentServiceAcquisition(key, managed, signal);
  if (healthy) {
    return;
  }
  if (managed.process && !hasLocalServiceProcessExited(managed.process)) {
    log.info(`restarting unhealthy ${provider} local service`);
    await stopManagedProcess(managed, signal);
  }

  const startedAt = Date.now();
  const diagnostics: LocalServiceDiagnostics = {
    providerId: provider,
    healthUrl,
    startedAt,
    stdoutTail: "",
    stderrTail: "",
  };
  managed.diagnostics = diagnostics;
  // Recheck after health/restart so the last lease cannot disappear before spawn.
  assertCurrentServiceAcquisition(key, managed, signal);
  log.info(`starting ${provider} local service: ${service.command}`);
  const serviceEnv = service.env ? mergeProcessEnv([process.env, service.env]) : process.env;
  const preparedSpawn = prepareLocalServiceSpawn(service.command, service.args ?? [], {
    env: serviceEnv,
  });
  managed.process = spawn(preparedSpawn.command, preparedSpawn.args, {
    cwd: service.cwd,
    env: preparedSpawn.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: shouldDetachChildForProcessTree(),
  });
  const child = managed.process;
  diagnostics.pid = child.pid;
  managed.lastExit = undefined;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  const captureStdout = (chunk: string) => {
    diagnostics.stdoutTail = appendLocalServiceOutputTail(
      diagnostics.stdoutTail,
      chunk,
      service.env,
      process.env,
      service.args,
      healthHeaders,
    );
  };
  const captureStderr = (chunk: string) => {
    diagnostics.stderrTail = appendLocalServiceOutputTail(
      diagnostics.stderrTail,
      chunk,
      service.env,
      process.env,
      service.args,
      healthHeaders,
    );
  };
  child.stdout?.on("data", captureStdout);
  child.stderr?.on("data", captureStderr);
  child.unref();
  child.once("exit", (code, signalLocal) => {
    const exit = { code, signal: signalLocal };
    diagnostics.lastExit = exit;
    log.info(
      `${provider} local service exited: ${signalLocal ? `signal=${signalLocal}` : `code=${code ?? 0}`}`,
    );
    if (managed.process === child) {
      managed.lastExit = exit;
      if (managed.processStop?.child !== child) {
        managed.process = undefined;
      }
    }
  });
  const spawnError = await waitForSpawnResult(child, signal);
  if (spawnError) {
    throw new Error(
      `${provider} local service failed to start: ${spawnError.message}${formatLocalServiceDiagnosticTail(diagnostics)}`,
    );
  }
  diagnostics.spawnedAt = Date.now();

  const readyTimeoutMs = resolvePositiveTimerTimeoutMs(
    service.readyTimeoutMs,
    DEFAULT_READY_TIMEOUT_MS,
  );
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (await probeHealth(healthUrl, healthHeaders, signal)) {
      diagnostics.readyAt = Date.now();
      diagnostics.lastHealthyAt = diagnostics.readyAt;
      // Drain readiness diagnostics so pipes cannot pin one-shot hosts.
      diagnostics.stdoutTail = "";
      diagnostics.stderrTail = "";
      drainLocalServiceOutput(child);
      log.info(
        `${provider} local service ready: pid=${diagnostics.pid ?? "unknown"} spawnMs=${diagnostics.spawnedAt - startedAt} readyMs=${diagnostics.readyAt - startedAt}`,
      );
      return;
    }
    if (managed.lastExit) {
      throw new Error(
        `${provider} local service exited before readiness with ${formatLocalServiceExit(
          managed.lastExit,
        )}${formatLocalServiceDiagnosticTail(diagnostics)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`${provider} local service did not become ready at ${healthUrl}`);
    }
    await sleepWithAbort(PROBE_INTERVAL_MS, signal, { ref: false });
  }
}

function unrefLocalServiceOutput(stream: ChildProcess["stdout"]): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

function drainLocalServiceOutput(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdout?.resume();
  child.stderr?.resume();
  unrefLocalServiceOutput(child.stdout);
  unrefLocalServiceOutput(child.stderr);
}

function scheduleIdleStop(
  key: string,
  managed: ManagedLocalService,
  service: ModelProviderLocalServiceConfig,
) {
  if (managed.stopping || services.get(key) !== managed) {
    return;
  }
  const idleStopMs = clampPositiveTimerTimeoutMs(service.idleStopMs);
  if (managed.active > 0) {
    return;
  }
  if (!managed.process) {
    if (!managed.starting) {
      services.delete(key);
      setManagedProviderLocalServicesActive(services.size > 0);
    }
    return;
  }
  if (idleStopMs === undefined) {
    return;
  }
  // Services without idleStopMs remain running until process exit or test cleanup.
  managed.idleTimer = setTimeout(() => {
    if (managed.active === 0) {
      void stopManagedService(key, managed, "idle").catch((error: unknown) => {
        log.warn("idle local model service shutdown failed", {
          error: toErrorObject(error, "Local model service shutdown failed").message,
        });
      });
    }
  }, idleStopMs);
  managed.idleTimer.unref?.();
}

function clearIdleTimer(managed: ManagedLocalService) {
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = undefined;
  }
}

function stopManagedService(
  key: string,
  managed: ManagedLocalService,
  reason: string,
): Promise<void> {
  const stopping = (managed.stopping ??= {});
  if (stopping.promise) {
    return stopping.promise;
  }
  clearIdleTimer(managed);
  const starting = managed.starting;
  const startupAbort = managed.startupAbort;
  managed.startupAbort = undefined;
  const pending = Promise.resolve()
    .then(async () => {
      startupAbort?.abort(new Error(`local service stopped: ${reason}`));
      if (managed.process && !hasLocalServiceProcessExited(managed.process)) {
        log.info(`stopping local model service: reason=${reason}`);
      }
      // Startup reports its error to its caller; shutdown must still join its tail.
      await starting?.catch(() => {});
      await stopManagedProcess(managed, new AbortController().signal);
      if (services.get(key) === managed) {
        services.delete(key);
      }
      setManagedProviderLocalServicesActive(services.size > 0);
    })
    .catch((error: unknown) => {
      // Keep retirement ownership; a later call may recheck a delayed process exit.
      stopping.promise = undefined;
      throw error;
    });
  stopping.promise = pending;
  return pending;
}

async function stopManagedProcess(managed: ManagedLocalService, signal: AbortSignal) {
  throwIfAborted(signal);
  if (!managed.processStop) {
    const child = managed.process;
    managed.lastExit = undefined;
    if (!child) {
      return;
    }
    managed.processStop = { child };
  }
  const stopping = managed.processStop;
  let pending = stopping.promise;
  if (!pending) {
    // Restart cancellation stops its waiter, not the process-tree cleanup owner.
    pending = Promise.resolve()
      .then(() => stopLocalServiceProcess(stopping.child))
      .then(() => {
        if (managed.process === stopping.child) {
          managed.process = undefined;
        }
        if (managed.processStop === stopping) {
          managed.processStop = undefined;
        }
      })
      .catch((error: unknown) => {
        stopping.promise = undefined;
        throw error;
      });
    stopping.promise = pending;
  }
  await waitForAbort(pending, signal);
}

async function stopLocalServiceProcess(child: ChildProcess): Promise<void> {
  if (!isChildProcessTreeAlive(child)) {
    return;
  }
  const signal = new AbortController().signal;
  drainLocalServiceOutput(child);
  signalChildProcessTree(child, "SIGTERM");
  await waitForChildProcessTreeExit(child, signal, DEFAULT_PROBE_TIMEOUT_MS);
  if (process.platform === "win32" || isChildProcessTreeAlive(child)) {
    forceKillChildProcessTree(child);
    await waitForChildProcessTreeExit(child, signal, DEFAULT_PROBE_TIMEOUT_MS);
  }
  if (isChildProcessTreeAlive(child)) {
    throw new Error(`Local model service process tree ${child.pid} did not stop`);
  }
}

function forceStopManagedService(key: string, managed: ManagedLocalService) {
  clearIdleTimer(managed);
  const child = managed.processStop?.child ?? managed.process;
  managed.process = undefined;
  if (services.get(key) === managed) {
    services.delete(key);
  }
  if (!child || !isChildProcessTreeAlive(child)) {
    return;
  }
  drainLocalServiceOutput(child);
  forceKillChildProcessTree(child);
}

function installExitHandler() {
  if (exitHandlerInstalled) {
    return;
  }
  exitHandlerInstalled = true;
  process.once("exit", () => {
    for (const [key, managed] of services) {
      forceStopManagedService(key, managed);
    }
    setManagedProviderLocalServicesActive(false);
  });
}

function toAbortError(signal?: AbortSignal | null): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw toAbortError(signal);
  }
}

function isAbortForSignal(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    Boolean(signal?.aborted) &&
    (error === signal?.reason || (error instanceof Error && error.name === "AbortError"))
  );
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(toAbortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

function waitForSpawnResult(
  child: ChildProcess,
  signal?: AbortSignal | null,
): Promise<Error | undefined> {
  throwIfAborted(signal);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("error", onError);
      child.off("spawn", onSpawn);
      signal?.removeEventListener("abort", onAbort);
      resolve(error);
    };
    const onError = (error: Error) => finish(error);
    const onSpawn = () => finish();
    const onAbort = () => finish(toAbortError(signal));
    child.once("error", onError);
    child.once("spawn", onSpawn);
    signal?.addEventListener("abort", onAbort, { once: true });
    setImmediate(() => {
      if (child.pid) {
        finish();
      }
    });
  });
}

async function waitForChildProcessTreeExit(
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isChildProcessTreeAlive(child)) {
    throwIfAborted(signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    await sleepWithAbort(Math.min(PROCESS_TREE_EXIT_POLL_MS, remainingMs), signal);
  }
}

/** Return whether a child process has already reported an exit code or signal. */
export function hasLocalServiceProcessExited(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
