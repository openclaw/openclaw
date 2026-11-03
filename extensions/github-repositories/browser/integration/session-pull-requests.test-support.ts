import { onTestFinished, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayEventListener,
  GatewayHelloOk,
} from "../../../../ui/src/api/gateway.ts";
import type {
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../../../ui/src/app/gateway.ts";
import {
  scopedSessionArtifactKey,
  parseAgentSessionKey,
  uiSessionEventMatches,
} from "../../../../ui/src/lib/sessions/session-key.ts";
import { createControlUiRequests } from "../../../../ui/src/plugins/control-ui-requests.ts";
import { createApplicationGatewaySnapshot } from "../../../../ui/src/test-helpers/application-context-fixtures.ts";
import {
  createRepositoryBrowserRuntime,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
} from "../../session-pull-requests-api.ts";

export function createHello(scopes: string[] = ["operator.read"]): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes },
    features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
  };
}

export function createGatewayHarness() {
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ subscribed: true });
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
    hello: createHello(),
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
  });
  const snapshotListeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const unsubscribeSnapshots = vi.fn();
  const unsubscribeEvents = vi.fn();
  const subscribeSnapshots = vi.fn((listener: (value: ApplicationGatewaySnapshot) => void) => {
    snapshotListeners.add(listener);
    return () => {
      unsubscribeSnapshots();
      snapshotListeners.delete(listener);
    };
  });
  const subscribeEvents = vi.fn((listener: GatewayEventListener) => {
    eventListeners.add(listener);
    return () => {
      unsubscribeEvents();
      eventListeners.delete(listener);
    };
  });
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    loadSelfProfile: async () => null,
    subscribe: subscribeSnapshots,
    subscribeEvents,
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    defer: () => false,
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as ApplicationGateway;
  const activation = new AbortController();
  const retained = new Set<() => void>();
  const requests = createControlUiRequests({
    current: () => ({ gateway }),
    signal: activation.signal,
    retain(dispose) {
      retained.add(dispose);
      return () => {
        retained.delete(dispose);
        dispose();
      };
    },
  });
  const repository = createRepositoryBrowserRuntime({
    requests,
    signal: activation.signal,
    sessions: {
      artifactKey: ({ sessionKey, agentId }) => scopedSessionArtifactKey(sessionKey, agentId),
      agentId: (key) => parseAgentSessionKey(key)?.agentId,
      matches: ({ sessionKey, agentId }, eventKey, eventAgentId) =>
        uiSessionEventMatches(
          {
            sessionKey,
            assistantAgentId: agentId ?? gateway.snapshot.assistantAgentId,
            hello: gateway.snapshot.hello,
          },
          eventKey,
          eventAgentId,
        ),
    } as Pick<
      import("openclaw/plugin-sdk/control-ui").ControlUiHostV2["sessions"],
      "artifactKey" | "agentId" | "matches"
    >,
  });
  onTestFinished(() => {
    activation.abort();
    retained.forEach((dispose) => dispose());
  });
  return {
    repository,
    requests,
    gateway,
    request,
    subscribeSnapshots,
    subscribeEvents,
    unsubscribeSnapshots,
    unsubscribeEvents,
    emit(payload: unknown, event = "controlUi.sessionPullRequests.changed") {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event,
          payload,
          seq: 1,
        });
      }
    },
    setSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
  };
}

export async function flushSync() {
  await Promise.resolve();
  await Promise.resolve();
}
