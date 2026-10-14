/**
 * Lazy ACPX runtime service registration. The plugin exposes an ACP backend
 * immediately, then imports the heavier service only when a session needs it.
 */
import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createLazyAcpRuntimeProxy, type CompleteAcpRuntime } from "./src/runtime-proxy.js";

const ACPX_BACKEND_ID = "acpx";

type RealAcpxServiceModule = typeof import("./src/service.js");
type InnerAcpxRuntimeServiceParams = NonNullable<
  Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]
>;
type CreateAcpxRuntimeServiceParams = Omit<
  InnerAcpxRuntimeServiceParams,
  "backendLifecycle" | "probeAtStartup" | "startupPurpose" | "assertCurrent"
>;

type DeferredServiceState = {
  ctx: OpenClawPluginServiceContext | null;
  published: boolean;
  lifecycleRevision: number;
  ownedRuntime: CompleteAcpRuntime | null;
  params: CreateAcpxRuntimeServiceParams;
  realService: ReturnType<RealAcpxServiceModule["createAcpxRuntimeService"]> | null;
  startPromise: Promise<CompleteAcpRuntime> | null;
  stopPromise: Promise<void> | null;
};

const loadServiceModule = createLazyRuntimeModule(() => import("./src/service.js"));

function unregisterOwnedRuntime(runtime: CompleteAcpRuntime | null): void {
  if (runtime && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime === runtime) {
    unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
  }
}

async function startRealService(
  state: DeferredServiceState,
  lifecycleRevision: number,
  deferredRuntime: CompleteAcpRuntime,
  purpose: "gateway" | "inspection" = "gateway",
  probeAtStartup = purpose === "gateway",
): Promise<CompleteAcpRuntime> {
  if (state.lifecycleRevision !== lifecycleRevision || !state.ctx) {
    throw new Error("ACPX runtime service is not started");
  }
  if (state.startPromise) {
    return await state.startPromise;
  }
  const ctx = state.ctx;
  state.startPromise = (async () => {
    let publishedRuntime: CompleteAcpRuntime | null = null;
    const { createAcpxRuntimeService: createAcpxRuntimeServiceLocal } = await loadServiceModule();
    const service = createAcpxRuntimeServiceLocal({
      ...state.params,
      probeAtStartup,
      startupPurpose: purpose,
      assertCurrent: () => {
        if (
          state.lifecycleRevision !== lifecycleRevision ||
          state.ctx !== ctx ||
          (state.published && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== state.ownedRuntime)
        ) {
          throw new Error("ACPX runtime service lost recovery ownership");
        }
      },
      backendLifecycle: {
        publish(backend) {
          if (state.lifecycleRevision !== lifecycleRevision || state.ctx !== ctx) {
            throw new Error("ACPX runtime service stopped during activation");
          }
          if (
            state.published &&
            getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== deferredRuntime
          ) {
            throw new Error("ACPX runtime service lost registry ownership during activation");
          }
          // Publication is a synchronous compare-and-replace: another plugin
          // generation cannot be adopted between the ownership check and write.
          if (state.published) {
            registerAcpRuntimeBackend({
              id: ACPX_BACKEND_ID,
              ...backend,
              runtime: deferredRuntime,
            });
          }
          publishedRuntime = backend.runtime;
        },
        // The outer service owns the stable facade and retracts it before inner cleanup.
        retract() {},
      },
    });
    state.realService = service;
    await service.start(ctx);
    if (state.lifecycleRevision !== lifecycleRevision || state.ctx !== ctx) {
      throw new Error("ACPX runtime service stopped during activation");
    }
    if (!publishedRuntime) {
      throw new Error("ACPX runtime service did not register an ACP backend");
    }
    if (state.published && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== deferredRuntime) {
      throw new Error("ACPX runtime service lost registry ownership during activation");
    }
    // Registry publication intentionally precedes the startup probe, but callers
    // must keep sharing the start promise until the inner service is fully ready.
    return publishedRuntime;
  })();
  try {
    return await state.startPromise;
  } catch (error) {
    if (state.lifecycleRevision === lifecycleRevision) {
      state.startPromise = null;
      state.realService = null;
    }
    throw error;
  }
}

function createDeferredRuntime(
  state: DeferredServiceState,
  lifecycleRevision: number,
): CompleteAcpRuntime {
  const deferredRuntime: CompleteAcpRuntime = createLazyAcpRuntimeProxy(
    (): Promise<CompleteAcpRuntime> => startRealService(state, lifecycleRevision, deferredRuntime),
  );
  return deferredRuntime;
}

/** Creates the plugin service that registers ACPX as an ACP runtime backend. */
export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService & {
  getRuntime: (ctx: OpenClawPluginServiceContext) => Promise<CompleteAcpRuntime>;
} {
  const state: DeferredServiceState = {
    ctx: null,
    published: false,
    lifecycleRevision: 0,
    ownedRuntime: null,
    params,
    realService: null,
    startPromise: null,
    stopPromise: null,
  };

  return {
    id: "acpx-runtime",
    async getRuntime(ctx) {
      if (state.stopPromise) {
        await state.stopPromise;
      }
      if (!state.ctx) {
        state.ctx = ctx;
        state.lifecycleRevision += 1;
        state.ownedRuntime = createDeferredRuntime(state, state.lifecycleRevision);
      }
      if (!state.ownedRuntime) {
        throw new Error("ACPX runtime service lost its runtime owner");
      }
      return await startRealService(
        state,
        state.lifecycleRevision,
        state.ownedRuntime,
        state.published ? "gateway" : "inspection",
        false,
      );
    },
    async start(ctx) {
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }
      if (state.stopPromise) {
        await state.stopPromise;
      }

      if (state.ctx && state.ownedRuntime) {
        const revision = state.lifecycleRevision;
        const previous = getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime;
        const assertCurrent = () => {
          const current = getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime;
          if (
            state.lifecycleRevision !== revision ||
            !state.ctx ||
            (current !== previous && current !== state.ownedRuntime)
          ) {
            throw new Error("ACPX runtime service lost promotion ownership");
          }
        };
        await state.startPromise;
        assertCurrent();
        await state.realService?.promote(ctx, assertCurrent);
        assertCurrent();
        state.published = true;
        registerAcpRuntimeBackend({ id: ACPX_BACKEND_ID, runtime: state.ownedRuntime });
        return;
      }
      state.published = true;
      state.lifecycleRevision += 1;
      const lifecycleRevision = state.lifecycleRevision;
      state.ctx = ctx;
      const deferredRuntime = createDeferredRuntime(state, lifecycleRevision);
      state.ownedRuntime = deferredRuntime;
      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime: deferredRuntime,
      });
      ctx.logger.info("embedded acpx runtime backend registered lazily");
    },
    async stop(ctx) {
      if (state.stopPromise) {
        return await state.stopPromise;
      }

      // Invalidate every deferred proxy before waiting for startup. The in-flight
      // service still owns cleanup, but it can no longer become the active runtime.
      state.lifecycleRevision += 1;
      state.ctx = null;
      state.published = false;
      const ownedRuntime = state.ownedRuntime;
      unregisterOwnedRuntime(ownedRuntime);
      const startPromise = state.startPromise;
      state.stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        try {
          await state.realService?.stop?.(ctx);
        } finally {
          unregisterOwnedRuntime(ownedRuntime);
          state.ownedRuntime = null;
          state.realService = null;
          state.startPromise = null;
        }
      })();
      try {
        await state.stopPromise;
      } finally {
        state.stopPromise = null;
      }
    },
  };
}
