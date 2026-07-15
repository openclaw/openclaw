import { describe, expect, it, vi } from "vitest";
import { startAgentMailGatewayAccount } from "./gateway.js";
import type { ResolvedAgentMailAccount } from "./types.js";

const mocks = vi.hoisted(() => ({
  routes: [] as Array<{ path: string; unregister: ReturnType<typeof vi.fn> }>,
  startWebSocket: vi.fn(async () => undefined),
}));
const apiVal = "key";
const hookVal = "hook-value";

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  waitUntilAbort: async (signal: AbortSignal, onAbort?: () => void) =>
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          onAbort?.();
          resolve();
        },
        { once: true },
      );
    }),
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  registerPluginHttpRoute: ({ path }: { path: string }) => {
    const unregister = vi.fn();
    mocks.routes.push({ path, unregister });
    return unregister;
  },
}));

vi.mock("./durable-receive.js", () => ({
  createAgentMailDurableInboundReceiveJournal: () => ({}),
}));

vi.mock("./ingress.js", () => ({
  processAgentMailIngress: vi.fn(async () => "accepted"),
  replayPendingAgentMailIngress: vi.fn(async () => undefined),
}));

vi.mock("./webhook.js", () => ({
  createAgentMailWebhookHandler: () => vi.fn(),
}));

vi.mock("./websocket.js", () => ({
  startAgentMailWebSocket: mocks.startWebSocket,
}));

function account(accountId: string, webhookPath: string): ResolvedAgentMailAccount {
  return {
    accountId,
    enabled: true,
    apiKey: apiVal,
    inboxId: `inbox_${accountId}`,
    webhookSecret: hookVal,
    webhookPath,
    dmPolicy: "allowlist",
    allowFrom: [],
    mediaMaxBytes: 20 * 1024 * 1024,
  };
}

describe("AgentMail gateway route ownership", () => {
  it("uses WebSocket only when no webhook secret is configured", async () => {
    mocks.routes.length = 0;
    mocks.startWebSocket.mockClear();
    const websocketAccount = { ...account("default", "/webhooks/agentmail"), webhookSecret: "" };
    await startAgentMailGatewayAccount({
      cfg: {},
      account: websocketAccount,
      channelRuntime: {} as never,
      abortSignal: new AbortController().signal,
    });
    expect(mocks.startWebSocket).toHaveBeenCalledOnce();
    expect(mocks.routes).toHaveLength(0);
  });

  it("releases an account's old path without letting stale cleanup remove its replacement", async () => {
    mocks.routes.length = 0;
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const thirdAbort = new AbortController();
    const runtime = {} as never;
    const first = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/old"),
      channelRuntime: runtime,
      abortSignal: firstAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(1));
    const second = startAgentMailGatewayAccount({
      cfg: {},
      account: account("support", "/webhooks/agentmail/new"),
      channelRuntime: runtime,
      abortSignal: secondAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(2));
    expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();

    firstAbort.abort();
    await first;
    expect(mocks.routes[0]?.unregister).toHaveBeenCalledOnce();
    const third = startAgentMailGatewayAccount({
      cfg: {},
      account: account("billing", "/webhooks/agentmail/old"),
      channelRuntime: runtime,
      abortSignal: thirdAbort.signal,
    });
    await vi.waitFor(() => expect(mocks.routes).toHaveLength(3));

    secondAbort.abort();
    thirdAbort.abort();
    await Promise.all([second, third]);
  });
});
