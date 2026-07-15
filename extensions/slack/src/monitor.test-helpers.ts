// Slack helper module supports monitor helpers behavior.
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { Mock } from "vitest";
import { resetSlackSharedSocketGroupsForTests } from "./monitor/shared-socket-group.js";

type SlackHandler = (args: unknown) => Promise<void>;
type SlackMiddleware = (args: { next: () => Promise<void> } & Record<string, unknown>) => unknown;
type SlackProviderMonitor = (params: {
  botToken: string;
  appToken: string;
  accountId?: string;
  abortSignal: AbortSignal;
  config?: Record<string, unknown>;
  channelRuntime?: ChannelRuntimeSurface;
  runtime?: RuntimeEnv;
}) => Promise<unknown>;

type SlackTestState = {
  config: Record<string, unknown>;
  appStartMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  appStopMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  sendMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  replyMock: Mock<(...args: unknown[]) => unknown>;
  updateLastRouteMock: Mock<(...args: unknown[]) => unknown>;
  reactMock: Mock<(...args: unknown[]) => unknown>;
  reactionAddMock: Mock<(...args: unknown[]) => unknown>;
  reactionRemoveMock: Mock<(...args: unknown[]) => unknown>;
  readAllowFromStoreMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  upsertPairingRequestMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  resolveSlackUserAllowlistMock: Mock<
    (params: { entries: string[] }) => Promise<Array<{ input: string; resolved: boolean }>>
  >;
  socketModeLogger?: { error: (...args: unknown[]) => void };
};

const slackTestState: SlackTestState = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  appStartMock: vi.fn(),
  appStopMock: vi.fn(),
  sendMock: vi.fn(),
  replyMock: vi.fn(),
  updateLastRouteMock: vi.fn(),
  reactMock: vi.fn(),
  reactionAddMock: vi.fn(),
  reactionRemoveMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveSlackUserAllowlistMock: vi.fn(),
  socketModeLogger: undefined,
}));

const slackInboundDeliveryTestCache = resolveGlobalDedupeCache(
  Symbol.for("openclaw.slackInboundDeliveries"),
  {
    ttlMs: 24 * 60 * 60 * 1000,
    maxSize: 20_000,
  },
);

export const getSlackTestState = (): SlackTestState => slackTestState;

type SlackClient = {
  auth: { test: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>> };
  conversations: {
    info: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
    replies: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
    history: Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;
  };
  users: {
    info: Mock<(...args: unknown[]) => Promise<{ user: { profile: { display_name: string } } }>>;
  };
  assistant: {
    threads: {
      setStatus: Mock<(...args: unknown[]) => Promise<{ ok: boolean }>>;
    };
  };
  reactions: {
    add: (...args: unknown[]) => unknown;
    remove: (...args: unknown[]) => unknown;
  };
};

export const getSlackHandlers = () => ensureSlackTestRuntime().handlers;

export const getSlackClient = () => ensureSlackTestRuntime().client;

// Default bot token used by startSlackMonitor() when a test doesn't pass its
// own. Every per-account WebClient the code under test constructs (via
// createSlackWebClient) is keyed by the token it was constructed with, so a
// second account started with a different botToken gets its own, independent
// mock client — see getSlackClientForToken.
export const DEFAULT_SLACK_TEST_BOT_TOKEN = "bot-token";

// Get-or-create a mock client dedicated to `token`, for tests that need a
// SECOND, genuinely distinct account identity (e.g. shared-app-token
// multi-account tests). Call this to register/configure the second account's
// client BEFORE starting its monitor. Tokens nobody explicitly registers this
// way keep resolving to the single default client (see
// resolveSlackClientForToken) so every pre-existing test that passes a custom
// botToken without expecting a distinct mock keeps working unchanged.
export const getSlackClientForToken = (token: string): SlackClient =>
  ensureSlackClientForToken(token);

function resolveSlackClientForToken(token: string): SlackClient {
  const { clientsByToken, client } = ensureSlackTestRuntime();
  return clientsByToken.get(token) ?? client;
}

function createMockSlackClient(): SlackClient {
  return {
    auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user", bot_id: "bot-id" }) },
    conversations: {
      info: vi.fn().mockResolvedValue({
        channel: { name: "dm", is_im: true },
      }),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
      history: vi.fn().mockResolvedValue({ messages: [] }),
    },
    users: {
      info: vi.fn().mockResolvedValue({
        user: { profile: { display_name: "Ada" } },
      }),
    },
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
    reactions: {
      add: (...args: unknown[]) => {
        slackTestState.reactionAddMock(...args);
        return slackTestState.reactMock(...args);
      },
      remove: (...args: unknown[]) => {
        slackTestState.reactionRemoveMock(...args);
        return slackTestState.reactMock(...args);
      },
    },
  };
}

function ensureSlackClientForToken(token: string): SlackClient {
  const { clientsByToken } = ensureSlackTestRuntime();
  let client = clientsByToken.get(token);
  if (!client) {
    client = createMockSlackClient();
    clientsByToken.set(token, client);
  }
  return client;
}

function ensureSlackTestRuntime(): {
  handlers: Map<string, SlackHandler>;
  // Raw per-event registrations, in registration order, keyed by event name.
  // Real Bolt invokes every listener registered for a matching event (this is
  // exactly what makes sharing one App across accounts work); `handlers`
  // above stores one composed function per name so getSlackHandlerOrThrow()
  // keeps its existing single-handler contract while still invoking all of
  // them.
  rawEventHandlersByName: Map<string, SlackHandler[]>;
  client: SlackClient;
  clientsByToken: Map<string, SlackClient>;
} {
  const globalState = globalThis as {
    __slackHandlers?: Map<string, SlackHandler>;
    __slackRawEventHandlersByName?: Map<string, SlackHandler[]>;
    __slackClient?: SlackClient;
    __slackClientsByToken?: Map<string, SlackClient>;
  };
  if (!globalState["__slackHandlers"]) {
    globalState["__slackHandlers"] = new Map<string, SlackHandler>();
  }
  if (!globalState["__slackRawEventHandlersByName"]) {
    globalState["__slackRawEventHandlersByName"] = new Map<string, SlackHandler[]>();
  }
  if (!globalState["__slackClientsByToken"]) {
    globalState["__slackClientsByToken"] = new Map<string, SlackClient>();
  }
  if (!globalState["__slackClient"]) {
    globalState["__slackClient"] = createMockSlackClient();
    globalState["__slackClientsByToken"].set(
      DEFAULT_SLACK_TEST_BOT_TOKEN,
      globalState["__slackClient"],
    );
  }
  return {
    handlers: globalState["__slackHandlers"],
    rawEventHandlersByName: globalState["__slackRawEventHandlersByName"],
    client: globalState["__slackClient"],
    clientsByToken: globalState["__slackClientsByToken"],
  };
}

export const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function waitForSlackEvent(name: string) {
  for (let i = 0; i < 10; i += 1) {
    if (getSlackHandlers()?.has(name)) {
      return;
    }
    await flush();
  }
}

export function startSlackMonitor(
  monitorSlackProvider: SlackProviderMonitor,
  opts?: {
    botToken?: string;
    appToken?: string;
    accountId?: string;
    config?: Record<string, unknown>;
    channelRuntime?: ChannelRuntimeSurface;
    runtime?: RuntimeEnv;
  },
) {
  const controller = new AbortController();
  const run = monitorSlackProvider({
    botToken: opts?.botToken ?? DEFAULT_SLACK_TEST_BOT_TOKEN,
    appToken: opts?.appToken ?? "app-token",
    accountId: opts?.accountId,
    abortSignal: controller.signal,
    config: opts?.config ?? slackTestState.config,
    channelRuntime: opts?.channelRuntime,
    runtime: opts?.runtime,
  });
  return { controller, run };
}

export async function getSlackHandlerOrThrow(name: string) {
  await waitForSlackEvent(name);
  const handler = getSlackHandlers()?.get(name);
  if (!handler) {
    throw new Error(`Slack ${name} handler not registered`);
  }
  return handler;
}

export async function stopSlackMonitor(params: {
  controller: AbortController;
  run: Promise<unknown>;
}) {
  await flush();
  params.controller.abort();
  await params.run;
}

async function runSlackEventOnce(
  monitorSlackProvider: SlackProviderMonitor,
  name: string,
  args: unknown,
  opts?: { botToken?: string; appToken?: string },
) {
  const { controller, run } = startSlackMonitor(monitorSlackProvider, opts);
  const handler = await getSlackHandlerOrThrow(name);
  await handler(args);
  await stopSlackMonitor({ controller, run });
}

export async function runSlackMessageOnce(
  monitorSlackProvider: SlackProviderMonitor,
  args: unknown,
  opts?: { botToken?: string; appToken?: string },
) {
  await runSlackEventOnce(monitorSlackProvider, "message", args, opts);
}

export const defaultSlackTestConfig = () => ({
  messages: {
    responsePrefix: "PFX",
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
  },
  channels: {
    slack: {
      dm: { enabled: true, policy: "open", allowFrom: ["*"] },
      groupPolicy: "open",
    },
  },
});

export function resetSlackTestState(config: Record<string, unknown> = defaultSlackTestConfig()) {
  slackInboundDeliveryTestCache.clear();
  slackTestState.config = config;
  slackTestState.socketModeLogger = undefined;
  slackTestState.appStartMock.mockReset().mockResolvedValue(undefined);
  slackTestState.appStopMock.mockReset().mockResolvedValue(undefined);
  slackTestState.sendMock.mockReset().mockResolvedValue(undefined);
  slackTestState.replyMock.mockReset();
  slackTestState.updateLastRouteMock.mockReset();
  slackTestState.reactMock.mockReset();
  slackTestState.reactionAddMock.mockReset();
  slackTestState.reactionRemoveMock.mockReset();
  slackTestState.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  slackTestState.upsertPairingRequestMock.mockReset().mockResolvedValue({
    code: "PAIRCODE",
    created: true,
  });
  slackTestState.resolveSlackUserAllowlistMock
    .mockReset()
    .mockImplementation(async ({ entries }) =>
      entries.map((input) => ({ input, resolved: false })),
    );
  const client = getSlackClient();
  client.auth.test.mockReset().mockResolvedValue({
    user_id: "bot-user",
    bot_id: "bot-id",
    app_id: "A_TEST",
    team_id: "T_TEST",
    is_enterprise_install: false,
  });
  client.conversations.info.mockReset().mockResolvedValue({
    channel: { name: "dm", is_im: true },
  });
  client.conversations.replies.mockReset().mockResolvedValue({ messages: [] });
  client.conversations.history.mockReset().mockResolvedValue({ messages: [] });
  client.users.info.mockReset().mockResolvedValue({
    user: { profile: { display_name: "Ada" } },
  });
  client.assistant.threads.setStatus.mockReset().mockResolvedValue({ ok: true });
  const { clientsByToken, rawEventHandlersByName } = ensureSlackTestRuntime();
  getSlackHandlers()?.clear();
  rawEventHandlersByName.clear();
  // Any per-token WebClient created by a previous test (e.g. a second
  // account in a shared-app-token test) must not leak into the next test;
  // only the default token's client (reset above) survives.
  clientsByToken.clear();
  clientsByToken.set(DEFAULT_SLACK_TEST_BOT_TOKEN, client);
  resetSlackSharedSocketGroupsForTests();
}

vi.mock("./monitor/config.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor/config.runtime.js")>(
    "./monitor/config.runtime.js",
  );
  return {
    ...actual,
    loadConfig: () => slackTestState.config,
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args: unknown[]) => slackTestState.updateLastRouteMock(...args),
  };
});

vi.mock("./monitor/reply.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor/reply.runtime.js")>(
    "./monitor/reply.runtime.js",
  );
  type BufferedDispatchParams = Parameters<
    typeof actual.dispatchReplyWithBufferedBlockDispatcher
  >[0];
  type ReplyResolver = NonNullable<BufferedDispatchParams["replyResolver"]>;
  const replyResolver: ReplyResolver = (...args) =>
    slackTestState.replyMock(...args) as ReturnType<ReplyResolver>;
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcher: (params: BufferedDispatchParams) =>
      actual.dispatchReplyWithBufferedBlockDispatcher({
        ...params,
        replyResolver,
      }),
  };
});

vi.mock("./resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: async ({ entries }: { entries: string[] }) =>
    entries.map((input) => ({ input, resolved: false })),
}));

vi.mock("./resolve-users.js", () => ({
  resolveSlackUserAllowlist: (params: { entries: string[] }) =>
    slackTestState.resolveSlackUserAllowlistMock(params),
}));

vi.mock("./monitor/send.runtime.js", () => {
  return {
    sendMessageSlack: (...args: unknown[]) => slackTestState.sendMock(...args),
  };
});

vi.mock("./monitor/conversation.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor/conversation.runtime.js")>(
    "./monitor/conversation.runtime.js",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) =>
      slackTestState.readAllowFromStoreMock(...args),
    recordInboundSession: vi.fn().mockResolvedValue(undefined),
    upsertChannelPairingRequest: (...args: unknown[]) =>
      slackTestState.upsertPairingRequestMock(...args),
  };
});

vi.mock("@slack/bolt", () => {
  const { handlers, rawEventHandlersByName, client: slackClient } = ensureSlackTestRuntime();
  class App {
    client = slackClient;
    receiver: unknown;
    middlewares: SlackMiddleware[] = [];

    constructor(args?: { receiver?: unknown }) {
      this.receiver = args?.receiver;
    }
    use(middleware: SlackMiddleware) {
      this.middlewares.push(middleware);
    }
    event(name: string, handler: SlackHandler) {
      // Real Bolt invokes every listener registered for a matching event —
      // this is the mechanism a shared App relies on to demux multiple
      // accounts' handlers. Track all registrations for `name` and, on
      // dispatch, run every one of them (each account's own
      // shouldDropMismatchedSlackEvent filter decides whether it acts).
      const registered = rawEventHandlersByName.get(name) ?? [];
      registered.push(handler);
      rawEventHandlersByName.set(name, registered);
      handlers.set(name, async (args: unknown) => {
        const eventArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const run = async (index: number): Promise<void> => {
          const middleware = this.middlewares[index];
          if (!middleware) {
            for (const registeredHandler of rawEventHandlersByName.get(name) ?? []) {
              await registeredHandler(args);
            }
            return;
          }
          await middleware({
            ...eventArgs,
            next: () => run(index + 1),
          });
        };
        await run(0);
      });
    }
    command() {
      /* no-op */
    }
    start = (...args: unknown[]) => slackTestState.appStartMock(...args);
    stop = (...args: unknown[]) => slackTestState.appStopMock(...args);
  }
  class HTTPReceiver {
    requestListener = vi.fn();
  }
  class SocketModeReceiver {
    client = {
      ...slackClient,
      on: vi.fn(),
      off: vi.fn(),
    };

    constructor(args: { logger?: { error: (...args: unknown[]) => void } }) {
      slackTestState.socketModeLogger = args.logger;
    }
  }
  return {
    App,
    HTTPReceiver,
    SocketModeReceiver,
    default: { App, HTTPReceiver, SocketModeReceiver },
  };
});

// createSlackWebClient()/createSlackWriteClient() construct a real
// `new WebClient(token, options)`. Route that through the same per-token
// mock registry as app.client so provider.ts's per-account client (used for
// auth.test() and ctx.client) resolves to the SAME mock object tests already
// assert against — for the default token this is literally getSlackClient().
vi.mock("@slack/web-api", () => {
  const WebClient = vi.fn(function WebClientMock(token: string) {
    return resolveSlackClientForToken(token);
  });
  return { WebClient };
});
