import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeStatus,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";

const ACPX_BACKEND_ID = "acpx";
const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";
const SKIP_RUNTIME_PROBE_ENV = "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE";

type RealAcpxServiceModule = typeof import("./src/service.js");
type CreateAcpxRuntimeServiceParams = NonNullable<
  Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]
>;

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  isHealthy(): boolean;
};
type AcpRuntimeTurnInput = Parameters<AcpRuntime["runTurn"]>[0];
type AcpRuntimeTurn = ReturnType<NonNullable<AcpRuntime["startTurn"]>>;
type AcpRuntimeTurnResult = Awaited<AcpRuntimeTurn["result"]>;

type DeferredServiceState = {
  ctx: OpenClawPluginServiceContext | null;
  params: CreateAcpxRuntimeServiceParams;
  realRuntime: AcpxRuntimeLike | null;
  realService: OpenClawPluginService | null;
  startPromise: Promise<AcpxRuntimeLike> | null;
};

let serviceModulePromise: Promise<RealAcpxServiceModule> | null = null;

function loadServiceModule(): Promise<RealAcpxServiceModule> {
  serviceModulePromise ??= import("./src/service.js");
  return serviceModulePromise;
}

function shouldRunStartupProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_STARTUP_PROBE_ENV] !== "0" && env[SKIP_RUNTIME_PROBE_ENV] !== "1";
}

function createDeferredResult<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class LegacyRunTurnEventQueue {
  private readonly items: AcpRuntimeEvent[] = [];
  private readonly waits: Array<{
    resolve: (value: AcpRuntimeEvent | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  push(item: AcpRuntimeEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waits.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  clear(): void {
    this.items.length = 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.resolve(null);
    }
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.error = error;
    this.closed = true;
    for (const waiter of this.waits.splice(0)) {
      waiter.reject(error);
    }
  }

  private async next(): Promise<AcpRuntimeEvent | null> {
    const item = this.items.shift();
    if (item) {
      return item;
    }
    if (this.error) {
      throw this.error;
    }
    if (this.closed) {
      return null;
    }
    return await new Promise<AcpRuntimeEvent | null>((resolve, reject) => {
      this.waits.push({ resolve, reject });
    });
  }

  async *iterate(): AsyncIterable<AcpRuntimeEvent> {
    for (;;) {
      const item = await this.next();
      if (!item) {
        return;
      }
      yield item;
    }
  }
}

function legacyRunTurnAsStartTurn(runtime: AcpRuntime, input: AcpRuntimeTurnInput): AcpRuntimeTurn {
  const result = createDeferredResult<AcpRuntimeTurnResult>();
  result.promise.catch(() => {});
  const queue = new LegacyRunTurnEventQueue();
  let resultSettled = false;
  const settleResult = (next: AcpRuntimeTurnResult) => {
    if (resultSettled) {
      return;
    }
    resultSettled = true;
    result.resolve(next);
  };
  void (async () => {
    try {
      for await (const event of runtime.runTurn(input)) {
        if (event.type === "done") {
          settleResult({
            status: "completed",
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          });
          continue;
        }
        if (event.type === "error") {
          settleResult({
            status: "failed",
            error: {
              message: event.message,
              ...(event.code ? { code: event.code } : {}),
              ...(event.detailCode ? { detailCode: event.detailCode } : {}),
              ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
            },
          });
          continue;
        }
        queue.push(event);
      }
      settleResult({
        status: "failed",
        error: {
          code: "ACP_TURN_FAILED",
          message: "ACP turn ended without a terminal done event.",
        },
      });
    } catch (error) {
      result.reject(error);
      queue.fail(error);
      return;
    }
    queue.close();
  })();
  return {
    requestId: input.requestId,
    events: queue.iterate(),
    result: result.promise,
    async cancel(inputArgs) {
      await runtime.cancel({ handle: input.handle, reason: inputArgs?.reason });
    },
    async closeStream() {
      queue.clear();
      queue.close();
    },
  };
}

function startRuntimeTurn(runtime: AcpRuntime, input: AcpRuntimeTurnInput): AcpRuntimeTurn {
  return runtime.startTurn?.(input) ?? legacyRunTurnAsStartTurn(runtime, input);
}

async function startRealService(state: DeferredServiceState): Promise<AcpxRuntimeLike> {
  if (state.realRuntime) {
    return state.realRuntime;
  }
  if (!state.ctx) {
    throw new Error("ACPX runtime service is not started");
  }
  state.startPromise ??= (async () => {
    const { createAcpxRuntimeService } = await loadServiceModule();
    const service = createAcpxRuntimeService(state.params);
    state.realService = service;
    await service.start(state.ctx as OpenClawPluginServiceContext);
    const backend = getAcpRuntimeBackend(ACPX_BACKEND_ID);
    if (!backend?.runtime) {
      throw new Error("ACPX runtime service did not register an ACP backend");
    }
    state.realRuntime = backend.runtime as AcpxRuntimeLike;
    return state.realRuntime;
  })();
  return await state.startPromise;
}

function createDeferredRuntime(state: DeferredServiceState): AcpxRuntimeLike {
  return {
    async ensureSession(input) {
      return await (await startRealService(state)).ensureSession(input);
    },
    startTurn(input) {
      const turnPromise = startRealService(state).then((runtime) =>
        startRuntimeTurn(runtime, input),
      );
      return {
        requestId: input.requestId,
        events: {
          async *[Symbol.asyncIterator]() {
            yield* (await turnPromise).events;
          },
        },
        result: turnPromise.then((turn) => turn.result),
        cancel(inputArgs) {
          return turnPromise.then((turn) => turn.cancel(inputArgs));
        },
        closeStream(inputArgs) {
          return turnPromise.then((turn) => turn.closeStream(inputArgs));
        },
      };
    },
    async *runTurn(input) {
      yield* (await startRealService(state)).runTurn(input);
    },
    async getCapabilities(input): Promise<AcpRuntimeCapabilities> {
      const runtime = await startRealService(state);
      return (await runtime.getCapabilities?.(input)) ?? { controls: [] };
    },
    async getStatus(input): Promise<AcpRuntimeStatus> {
      const runtime = await startRealService(state);
      return (await runtime.getStatus?.(input)) ?? {};
    },
    async setMode(input) {
      await (await startRealService(state)).setMode?.(input);
    },
    async setConfigOption(input) {
      await (await startRealService(state)).setConfigOption?.(input);
    },
    async doctor(): Promise<AcpRuntimeDoctorReport> {
      const runtime = await startRealService(state);
      return (await runtime.doctor?.()) ?? { ok: true, message: "ok" };
    },
    async prepareFreshSession(input) {
      await (await startRealService(state)).prepareFreshSession?.(input);
    },
    async cancel(input) {
      await (await startRealService(state)).cancel(input);
    },
    async close(input) {
      await (await startRealService(state)).close(input);
    },
    async probeAvailability() {
      await (await startRealService(state)).probeAvailability();
    },
    isHealthy() {
      return state.realRuntime?.isHealthy() ?? false;
    },
  };
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  const state: DeferredServiceState = {
    ctx: null,
    params,
    realRuntime: null,
    realService: null,
    startPromise: null,
  };

  return {
    id: "acpx-runtime",
    async start(ctx) {
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }

      state.ctx = ctx;
      if (shouldRunStartupProbe()) {
        await startRealService(state);
        return;
      }

      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime: createDeferredRuntime(state),
      });
      ctx.logger.info("embedded acpx runtime backend registered lazily");
    },
    async stop(ctx) {
      if (state.realService) {
        await state.realService.stop?.(ctx);
      } else {
        unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      }
      state.ctx = null;
      state.realRuntime = null;
      state.realService = null;
      state.startPromise = null;
    },
  };
}
