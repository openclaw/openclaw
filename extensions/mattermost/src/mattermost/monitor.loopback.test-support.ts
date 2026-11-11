import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { MattermostConfig } from "../types.js";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient } from "./client.js";
import { createMattermostMonitorResources } from "./monitor-resources.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

export const LOOPBACK_TOKEN = "mattermost-loopback-monitor-token";
export const LOOPBACK_CHANNEL_ID = "chan-1";
export const LOOPBACK_SESSION_KEY = `mattermost:default:channel:${LOOPBACK_CHANNEL_ID}`;

/**
 * Serves bearer-guarded JSON payloads by request path and returns the request lines seen.
 * A function payload runs per request, so a test can change gateway state mid-flight.
 */
export async function withLoopbackMattermost(
  payloads: Record<string, unknown>,
  run: (baseUrl: string) => Promise<void>,
): Promise<string[]> {
  const requests: string[] = [];
  await withServer((request, response) => {
    const url = request.url ?? "";
    requests.push(`${request.method ?? "GET"} ${url}`);
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${LOOPBACK_TOKEN}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    const entry = Object.hasOwn(payloads, url) ? payloads[url] : undefined;
    const payload = typeof entry === "function" ? entry() : entry;
    response.writeHead(payload ? 200 : 404);
    response.end(JSON.stringify(payload ?? { message: "unknown loopback endpoint" }));
  }, run);
  return requests;
}

/** Builds a monitor context against the loopback server and installs its runtime mock. */
export function createLoopbackMonitorContext(params: {
  baseUrl: string;
  enqueueSystemEvent: MattermostMonitorContext["core"]["system"]["enqueueSystemEvent"];
  config?: Partial<MattermostConfig>;
  /** Configuration the gateway holds at event time when it differs from startup. */
  current?: Partial<MattermostConfig>;
}): MattermostMonitorContext {
  const runtimeCore = createPluginRuntimeMock();
  runtimeCore.channel.routing.resolveAgentRoute = () => ({
    channel: "mattermost",
    matchedBy: "default",
    accountId: "default",
    agentId: "main",
    lastRoutePolicy: "main",
    mainSessionKey: LOOPBACK_SESSION_KEY,
    sessionKey: LOOPBACK_SESSION_KEY,
  });
  runtimeCore.system.enqueueSystemEvent = params.enqueueSystemEvent;
  setMattermostRuntime(runtimeCore);
  const connection = { baseUrl: params.baseUrl, botToken: LOOPBACK_TOKEN };
  const client = createMattermostClient({ ...connection, allowPrivateNetwork: true });
  const resources = createMattermostMonitorResources({
    accountId: "default",
    callbackUrl: "http://127.0.0.1:9/mattermost/callback",
    client,
    logger: { debug: () => {} },
    mediaMaxBytes: 1024,
    saveRemoteMedia: async () => ({ path: "/tmp/mattermost-loopback-media" }),
    mediaKindFromMime: () => null,
  });
  const mattermost = { ...connection, enabled: true, dmPolicy: "open", ...params.config };
  const cfg = { channels: { mattermost } };
  runtimeCore.config.current = vi.fn(() => ({
    channels: { mattermost: { ...mattermost, ...params.current } },
  }));
  return {
    account: resolveMattermostAccount({ cfg }),
    botUserId: "bot-user",
    cfg,
    client,
    core: runtimeCore,
    groupPolicy: mattermost.groupPolicy ?? "open",
    pairing: { readAllowFromStore: async () => [] },
    resources,
    runtime: { error: vi.fn() },
    logVerboseMessage: () => {},
    logDebugMessage: () => {},
  } as unknown as MattermostMonitorContext;
}
