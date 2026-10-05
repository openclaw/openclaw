import { randomUUID } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { vi } from "vitest";
import { resolveXAccount, type ResolvedXAccount } from "../accounts.js";
import type { XApiClient, XPage, XPost } from "../api.js";
import { getXApi } from "../client.js";
import { startXAccount } from "../monitor.js";
import { setXRuntime } from "../runtime.js";
import { createKeyedState, createQueue } from "./monitor.js";
import { createXTestSpend } from "./spend.js";

export const client = { getXApi: vi.mocked(getXApi) };

export type Payload = { version: number; rawEvent: string };
type Plan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];

export function post(id: string, authorId: string, text = "@roboclawbot please help"): XPost {
  return {
    id,
    author_id: authorId,
    conversation_id: "500",
    text,
    created_at: "2026-09-08T12:00:00Z",
  };
}
export function page(data: XPost[]): XPage {
  return {
    data,
    includes: {
      tweets: [],
      users: [
        { id: "10", username: "config_maintainer" },
        { id: "30", username: "stored_maintainer" },
      ],
    },
    meta: {},
  };
}
export const config: OpenClawConfig = {
  agents: { entries: { maintainer: {} } },
  bindings: [
    {
      agentId: "maintainer",
      match: { channel: "x", accountId: "default", peer: { kind: "group", id: "500" } },
    },
  ],
  channels: {
    x: {
      userId: "100",
      username: "roboclawbot",
      clientId: "test-client",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      allowFrom: ["x:10"],
      groupPolicy: "allowlist",
      events: { mode: "poll", pollSeconds: 60 },
      replySignature: "",
    },
  },
};

export function fixture(options: {
  posts: XPost[];
  queue?: ChannelIngressQueue<Payload>;
  onCursor?: () => void;
  cfg?: OpenClawConfig;
}) {
  const cfg = options.cfg ?? config;
  const replies: Array<{ text: string; parent: string }> = [];
  const api = {
    spend: createXTestSpend(),
    getMentions: vi.fn(async (_params: Parameters<XApiClient["getMentions"]>[0]) =>
      page(options.posts),
    ),
    getPosts: vi.fn(async (ids: string[]) =>
      page(options.posts.filter((value) => ids.includes(value.id))),
    ),
    searchConversation: vi.fn(async () => page([post("500", "10", "Original thread")])),
    getUserByUsername: vi.fn(async () => {
      throw new Error("Unexpected user lookup");
    }),
    reply: vi.fn(async (params: Parameters<XApiClient["reply"]>[0]) => {
      const assertCurrent = await params.assertActive?.();
      assertCurrent?.();
      replies.push({ text: params.text, parent: params.inReplyToId });
      return String(900 + replies.length);
    }),
    ensureActivitySubscriptions: vi.fn(async () => {}),
    openActivityStream: vi.fn(async () => {
      throw new Error("Unexpected stream");
    }),
  } satisfies XApiClient;
  client.getXApi.mockResolvedValue(api);
  const resolveStable = vi.fn(resolveStableChannelMessageIngress);
  const dispatch = vi.fn(async (plan: Plan) => {
    plan.replyOptions?.onVisibleWorkSessions?.([
      {
        sessionKey: "agent:maintainer:work:example",
        url: "https://example.test/work/42",
        label: "Work session",
      },
    ]);
    if (!plan.delivery.deliver) {
      throw new Error("Missing X text delivery adapter");
    }
    await plan.delivery.deliver({ text: "I am on it." }, { kind: "final" });
    await plan.turnAdoptionLifecycle?.onAdopted();
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true as const,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    };
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const openKeyedStore = createKeyedState((namespace, value) => {
    if (namespace === "x.cursor" && value && typeof value === "object" && "sinceId" in value) {
      options.onCursor?.();
    }
  });
  const queue = options.queue ?? createQueue<Payload>();
  // The host doubles expose only the runtime facilities this channel consumes.
  const stateDir = `synthetic-x-monitor:${randomUUID()}`;
  const runtime = {
    state: {
      openKeyedStore,
      resolveStateDir: () => stateDir,
      openChannelIngressQueue: () => queue,
    },
    logging: { getChildLogger: () => logger },
    channel: {
      inbound: {
        ingress: { resolveStable },
        buildContext: buildChannelInboundEventContext,
        dispatch,
      },
    },
  } as unknown as PluginRuntime;
  setXRuntime(runtime);
  const running: Array<{ abort: AbortController; run: Promise<unknown> }> = [];
  const start = () => {
    const abort = new AbortController();
    let status: ReturnType<ChannelGatewayContext<ResolvedXAccount>["getStatus"]> = {
      accountId: "default",
    };
    const context: ChannelGatewayContext<ResolvedXAccount> = {
      cfg,
      accountId: "default",
      account: resolveXAccount(cfg, "default"),
      abortSignal: abort.signal,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code) => {
          throw new Error(`Unexpected runtime exit: ${code}`);
        },
      },
      getStatus: () => status,
      setStatus: (next) => {
        status = next;
      },
    };
    const run = startXAccount(context);
    running.push({ abort, run });
    return { abort, run, status: () => status };
  };
  return {
    api,
    replies,
    dispatch,
    resolveStable,
    logger,
    runtime,
    openKeyedStore,
    start,
    async stop() {
      for (const item of running) {
        item.abort.abort();
      }
      await Promise.all(running.map((item) => item.run));
    },
  };
}
