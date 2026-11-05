import { createAgentRegistry } from "acpx/agent-registry";
import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { ACPX_NATIVE_AGENT_IDS } from "./src/config-schema.js";
import { createAcpAgentHarness } from "./src/harness.js";
import { isAcpxNativeAgentEnabled, listAcpxNativeAgents } from "./src/native-agents.js";
import { registerPiSessionCatalog } from "./src/pi-session-catalog-plugin.js";
import { createLazyAcpRuntimeProxy, type CompleteAcpRuntime } from "./src/runtime-proxy.js";

const ACPX_BACKEND_ID = "acpx";
type RealAcpxServiceModule = typeof import("./src/service.js");
const loadServiceModule = createLazyRuntimeModule(() => import("./src/service.js"));

function unregisterOwnedRuntime(runtime: CompleteAcpRuntime | null): void {
  if (runtime && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime === runtime) {
    unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
  }
}

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    registerPiSessionCatalog(api);
    const pluginConfig = api.pluginConfig;
    let ctx: OpenClawPluginServiceContext | null = null;
    let published = false;
    let lifecycleRevision = 0;
    let ownedRuntime: CompleteAcpRuntime | null = null;
    let realService: ReturnType<RealAcpxServiceModule["createAcpxRuntimeService"]> | null = null;
    let startPromise: Promise<CompleteAcpRuntime> | null = null;
    let stopPromise: Promise<void> | null = null;
    async function startRealService(
      expectedRevision: number,
      deferredRuntime: CompleteAcpRuntime,
      purpose: "gateway" | "inspection" = "gateway",
      probeAtStartup = purpose === "gateway",
    ): Promise<CompleteAcpRuntime> {
      if (lifecycleRevision !== expectedRevision || !ctx) {
        throw new Error("ACPX runtime service is not started");
      }
      if (startPromise) {
        return await startPromise;
      }
      const activeContext = ctx;
      let starting = true;
      startPromise = (async () => {
        let publishedRuntime: CompleteAcpRuntime | null = null;
        const { createAcpxRuntimeService: createAcpxRuntimeServiceLocal } =
          await loadServiceModule();
        const activeService = createAcpxRuntimeServiceLocal({
          pluginConfig,
          getAllowedAgents: () => api.runtime.config.current().acp?.allowedAgents,
          openKeyedStore: (options) => api.runtime.state.openKeyedStoreV2(options),
          probeAtStartup,
          startupPurpose: purpose,
          assertCurrent: () => {
            if (
              lifecycleRevision !== expectedRevision ||
              ctx !== activeContext ||
              (published && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== ownedRuntime)
            ) {
              throw new Error("ACPX runtime service lost recovery ownership");
            }
          },
          backendLifecycle: {
            publish(backend) {
              if (lifecycleRevision !== expectedRevision || ctx !== activeContext) {
                throw new Error("ACPX runtime service stopped during activation");
              }
              if (published && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== deferredRuntime) {
                throw new Error("ACPX runtime service lost registry ownership during activation");
              }
              // Publication is a synchronous compare-and-replace: another plugin
              // generation cannot be adopted between the ownership check and write.
              if (published) {
                const { healthy } = backend;
                registerAcpRuntimeBackend({
                  id: ACPX_BACKEND_ID,
                  ...backend,
                  runtime: deferredRuntime,
                  // The facade can accept callers while they share the bounded startup probe.
                  ...(healthy ? { healthy: () => starting || healthy() } : {}),
                });
              }
              publishedRuntime = backend.runtime;
            },
            // The outer service owns the stable facade and retracts it before inner cleanup.
            retract() {},
          },
        });
        realService = activeService;
        await activeService.start(activeContext);
        if (lifecycleRevision !== expectedRevision || ctx !== activeContext) {
          throw new Error("ACPX runtime service stopped during activation");
        }
        if (!publishedRuntime) {
          throw new Error("ACPX runtime service did not register an ACP backend");
        }
        if (published && getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime !== deferredRuntime) {
          throw new Error("ACPX runtime service lost registry ownership during activation");
        }
        // Registry publication intentionally precedes the startup probe, but callers
        // must keep sharing the start promise until the inner service is fully ready.
        return publishedRuntime;
      })().finally(() => {
        starting = false;
      });
      try {
        return await startPromise;
      } catch (error) {
        if (lifecycleRevision === expectedRevision) {
          startPromise = null;
          realService = null;
        }
        throw error;
      }
    }

    function createDeferredRuntime(expectedRevision: number): CompleteAcpRuntime {
      const deferredRuntime: CompleteAcpRuntime = {
        ...createLazyAcpRuntimeProxy(() => startRealService(expectedRevision, deferredRuntime)),
        async ensureSession(input) {
          const runtime = await startRealService(expectedRevision, deferredRuntime);
          // Recheck the published health after startup; doctor must remain available for recovery.
          requireAcpRuntimeBackend(ACPX_BACKEND_ID);
          return await runtime.ensureSession(input);
        },
      };
      return deferredRuntime;
    }

    const service: OpenClawPluginService & {
      getRuntime: (serviceContext: OpenClawPluginServiceContext) => Promise<CompleteAcpRuntime>;
    } = {
      id: "acpx-runtime",
      async getRuntime(serviceContext) {
        if (stopPromise) {
          await stopPromise;
        }
        if (!ctx) {
          ctx = serviceContext;
          lifecycleRevision += 1;
          ownedRuntime = createDeferredRuntime(lifecycleRevision);
        }
        if (!ownedRuntime) {
          throw new Error("ACPX runtime service lost its runtime owner");
        }
        return await startRealService(
          lifecycleRevision,
          ownedRuntime,
          published ? "gateway" : "inspection",
          false,
        );
      },
      async start(serviceContext) {
        if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
          serviceContext.logger.info(
            "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
          );
          return;
        }
        if (stopPromise) {
          await stopPromise;
        }

        if (ctx && ownedRuntime) {
          const revision = lifecycleRevision;
          const previous = getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime;
          const assertCurrent = () => {
            const current = getAcpRuntimeBackend(ACPX_BACKEND_ID)?.runtime;
            if (
              lifecycleRevision !== revision ||
              !ctx ||
              (current !== previous && current !== ownedRuntime)
            ) {
              throw new Error("ACPX runtime service lost promotion ownership");
            }
          };
          await startPromise;
          assertCurrent();
          await realService?.promote(serviceContext, assertCurrent);
          assertCurrent();
          published = true;
          registerAcpRuntimeBackend({ id: ACPX_BACKEND_ID, runtime: ownedRuntime });
          return;
        }
        published = true;
        lifecycleRevision += 1;
        ctx = serviceContext;
        const deferredRuntime = createDeferredRuntime(lifecycleRevision);
        ownedRuntime = deferredRuntime;
        registerAcpRuntimeBackend({
          id: ACPX_BACKEND_ID,
          runtime: deferredRuntime,
        });
        serviceContext.logger.info("embedded acpx runtime backend registered lazily");
      },
      async stop(serviceContext) {
        if (stopPromise) {
          return await stopPromise;
        }

        // Invalidate every deferred proxy before waiting for startup. The in-flight
        // service still owns cleanup, but it can no longer become the active runtime.
        lifecycleRevision += 1;
        ctx = null;
        published = false;
        const stoppingRuntime = ownedRuntime;
        unregisterOwnedRuntime(stoppingRuntime);
        const startingPromise = startPromise;
        stopPromise = (async () => {
          await startingPromise?.catch(() => undefined);
          try {
            await realService?.stop?.(serviceContext);
          } finally {
            unregisterOwnedRuntime(stoppingRuntime);
            ownedRuntime = null;
            realService = null;
            startPromise = null;
          }
        })();
        try {
          await stopPromise;
        } finally {
          stopPromise = null;
        }
      },
    };
    api.registerService(service);
    const currentConfig = () => api.runtime.config.current().plugins?.entries?.acpx?.config;
    const registry = createAgentRegistry();
    const nativeAgents = ACPX_NATIVE_AGENT_IDS.map((agentId) => {
      const agent = registry.inspect(agentId);
      if (!agent) {
        throw new Error(`Unknown ACP harness: ${agentId}`);
      }
      api.registerAgentHarness(
        createAcpAgentHarness({
          agent: agentId,
          label: agent.name,
          isEnabled: () => isAcpxNativeAgentEnabled(currentConfig()?.nativeAgents, agentId),
          api,
          getRuntime: service.getRuntime,
          shutdown: () => stopPromise ?? (ctx ? service.stop?.(ctx) : undefined),
        }),
      );
      return { id: agentId, name: agent.name, runtimeId: `acp-${agentId}` };
    });
    api.registerReload({ noopPrefixes: ["plugins.entries.acpx.config.nativeAgents"] });
    api.registerGatewayMethod(
      "acpx.agents.list",
      ({ params, respond }) => {
        if (Object.keys(params).length > 0) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "acpx.agents.list takes no parameters",
          });
          return;
        }
        respond(true, { agents: listAcpxNativeAgents(currentConfig(), nativeAgents) }, undefined);
      },
      { scope: "operator.read", profileAccess: "independent" },
    );
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  },
};

export default plugin;
