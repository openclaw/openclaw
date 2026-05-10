/**
 * Bridges the HA state store and WS client onto the OpenClaw gateway WS.
 *
 * Two gateway methods are registered with the host:
 *   - `home-assistant.subscribe` (read scope) -- the kiosk calls this on
 *     mount. The bridge captures the broadcast function from the request
 *     context, returns a snapshot of currently-cached allow-listed entities,
 *     and from then on every state-store diff is pushed to all connected
 *     clients on `plugin.home-assistant.state`.
 *   - `home-assistant.serviceCall` (write scope) -- the kiosk calls this on
 *     tile tap. The bridge validates payload shape, runs the call through
 *     `allowlist.ts` (deny-list + entity allow-list), and dispatches via
 *     `ws-client.callService`. Echo back via the normal state-changed flow.
 *
 * Plan deviation (recorded explicitly): the original kiosk plan called for
 * defining `ha:state` / `ha:service-call` in `src/gateway/protocol/`. After
 * inspecting the gateway, plugin broadcasts already use the `plugin.*`
 * namespace and method handlers register against arbitrary string method
 * names (see `src/gateway/server-broadcast.ts` `EVENT_SCOPE_GUARDS`, and
 * `OpenClawPluginApi.registerGatewayMethod` in `src/plugins/types.ts`). No
 * core protocol additions are needed; the bridge stays fully extension-
 * local per the boundary rules in `extensions/CLAUDE.md`.
 */

import { checkServiceCall, isEntityAllowed } from "./allowlist.js";
import type { HomeAssistantConfig } from "./config-schema.js";
import type { HomeAssistantStateStore, StateDiff } from "./state-store.js";

// -- Topic / method constants ------------------------------------------------

/**
 * Server -> client push topic. Plugin broadcasts must live under `plugin.*`
 * to satisfy the gateway's per-event scope guard for non-core events.
 */
export const HA_STATE_EVENT = "plugin.home-assistant.state";
export const HA_SUBSCRIBE_METHOD = "home-assistant.subscribe";
export const HA_SERVICE_CALL_METHOD = "home-assistant.serviceCall";

// -- Public types we consume from the host ----------------------------------

export type BridgeBroadcastFn = (event: string, payload: unknown) => void;

export type BridgeGatewayHandlerArgs = {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
  context: { broadcast: BridgeBroadcastFn };
};

export type BridgeGatewayHandler = (args: BridgeGatewayHandlerArgs) => Promise<void> | void;

/**
 * Minimal slice of `OpenClawPluginApi` the bridge depends on. Tests pass a
 * fake; production wiring (in `register.runtime.ts`) passes the real
 * `OpenClawPluginApi`, which is structurally compatible.
 */
export type BridgeGatewayApi = {
  registerGatewayMethod: (
    method: string,
    handler: BridgeGatewayHandler,
    opts?: { scope?: string },
  ) => void;
};

/** Subset of HomeAssistantClient the bridge calls. */
export type ServiceCallClient = {
  callService(args: {
    domain: string;
    service: string;
    target: string;
    serviceData?: Record<string, unknown>;
  }): void;
};

export type BridgeLogger = (entry: {
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
}) => void;

export type AttachBridgeArgs = {
  api: BridgeGatewayApi;
  store: HomeAssistantStateStore;
  client: ServiceCallClient;
  config: Pick<HomeAssistantConfig, "allowList" | "denyServiceList">;
  logger?: BridgeLogger;
};

export type BridgeHandle = {
  detach: () => void;
};

// -- Implementation ---------------------------------------------------------

export function attachHomeAssistantBridge(args: AttachBridgeArgs): BridgeHandle {
  const { api, store, client, config, logger = () => undefined } = args;
  const allowSet = new Set(config.allowList);

  let captured: BridgeBroadcastFn | null = null;
  let detached = false;

  const onDiff = (diff: StateDiff): void => {
    if (detached || !captured) {
      return;
    }
    // Defense in depth: the store should already filter to allowList, but
    // bridge-side config can be narrower than store-side config (e.g. when
    // a single store backs multiple bridge instances in the future).
    if (!allowSet.has(diff.entity_id)) {
      return;
    }
    try {
      captured(HA_STATE_EVENT, {
        entity_id: diff.entity_id,
        prev: diff.prev,
        next: diff.next,
      });
    } catch (cause) {
      logger({
        level: "warn",
        message: "ha-bridge.broadcast-failed",
        data: { entity_id: diff.entity_id, cause: String(cause) },
      });
    }
  };

  const unsubscribe = store.subscribeAll(onDiff);

  api.registerGatewayMethod(
    HA_SUBSCRIBE_METHOD,
    async ({ context, respond }) => {
      captured = context.broadcast;
      const snapshot = config.allowList.flatMap((entity_id) => {
        const state = store.get(entity_id);
        return state ? [{ entity_id, state }] : [];
      });
      respond(true, { snapshot });
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    HA_SERVICE_CALL_METHOD,
    async ({ params, respond }) => {
      const target = readString(params.target);
      if (!target) {
        respond(false, undefined, {
          code: "invalid_params",
          message: "target entity_id is required",
        });
        return;
      }

      const check = checkServiceCall({ domain: params.domain, service: params.service }, config);
      if (!check.allowed) {
        respond(false, undefined, {
          code: check.reason.kind,
          message: check.reason.detail,
        });
        return;
      }

      if (!isEntityAllowed(target, config)) {
        respond(false, undefined, {
          code: "entity-denied",
          message: `entity "${target}" is not in allowList`,
        });
        return;
      }

      try {
        const serviceData = readRecord(params.serviceData);
        client.callService({
          domain: check.domain,
          service: check.service,
          target,
          ...(serviceData ? { serviceData } : {}),
        });
        respond(true, { dispatched: true });
      } catch (cause) {
        respond(false, undefined, {
          code: "ha_call_failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    { scope: "operator.write" },
  );

  return {
    detach: () => {
      detached = true;
      unsubscribe();
      captured = null;
    },
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
