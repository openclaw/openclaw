// Real UI subscription owner over a benchmark WebSocket client, without rendering a browser.
import type {
  GatewayBrowserClient,
  GatewayEventListener,
  GatewayHelloOk,
} from "../../ui/src/api/gateway.ts";
import type { ApplicationGateway } from "../../ui/src/app/gateway.ts";
import { sessionPullRequestsForGateway } from "../../ui/src/lib/session-pull-requests.ts";
import type { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

export function attachGitHubVolumeUi(
  transport: ReturnType<typeof createGatewayWsClient>,
  hello: GatewayHelloOk,
  sessionKey: string,
) {
  const events = new Set<GatewayEventListener>();
  const calls: Array<{
    startedAtEpochMs: number;
    durationMs: number;
    refresh: boolean;
    ok: boolean;
  }> = [];
  // The UI only consumes request(); all calls still traverse the real Gateway transport.
  const client = {
    async request(method: string, params: unknown) {
      const startedAtEpochMs = Date.now();
      const call = {
        startedAtEpochMs,
        durationMs: 0,
        refresh: Boolean(params && typeof params === "object" && "refreshSessionKeys" in params),
        ok: false,
      };
      calls.push(call);
      try {
        const response = await transport.request(method, params, 30_000);
        call.ok = response.ok;
        if (!response.ok) {
          throw new Error(JSON.stringify(response.error));
        }
        return response.payload;
      } finally {
        call.durationMs = Date.now() - startedAtEpochMs;
      }
    },
  } as GatewayBrowserClient;
  const gateway: ApplicationGateway = {
    snapshot: {
      client,
      hello,
      phase: "connected",
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey,
      lastError: null,
      lastErrorCode: null,
    },
    connection: { gatewayUrl: "ws://127.0.0.1", token: "", password: "", bootstrapToken: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    connect() {},
    defer: () => false,
    setSessionKey() {},
    start() {},
    stop() {},
    subscribe: () => () => {},
    subscribeEventLog: () => () => {},
    loadSelfProfile: async () => null,
    subscribeEvents(listener) {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
  };
  const store = sessionPullRequestsForGateway(gateway);
  const watch = {};
  store.watch(watch, [sessionKey], { foreground: true });
  const emit: GatewayEventListener = (event) => {
    for (const listener of events) {
      listener(event);
    }
  };
  return {
    emit,
    calls,
    snapshot: () => store.get(sessionKey),
    stop() {
      store.unwatch(watch);
    },
  };
}
