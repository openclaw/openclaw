import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
// Slack helper module supports monitor helpers behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { vi } from "vitest";
import type { Mock } from "vitest";
import { setSlackRuntime } from "./runtime.js";
import type { sendMessageSlack } from "./send.js";

type SlackHandler = (args: unknown) => Promise<void>;
type SlackMiddleware = (args: { next: () => Promise<void> } & Record<string, unknown>) => unknown;
type SlackProviderMonitor = (params: {
  botToken: string;
  appToken: string;
  abortSignal: AbortSignal;
  config?: Record<string, unknown>;
  channelRuntime?: ChannelRuntimeSurface;
  runtime?: RuntimeEnv;
  setStatus?: (next: Record<string, unknown>) => void;
}) => Promise<unknown>;
type SlackStartupAuthClientFactory = typeof import("./client.js").createSlackStartupAuthClient;

const createSlackTestEvent = vi.hoisted(() => () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
});

const SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY = "openclawIngressLifecycle";

type SlackRunOnceOptions = {
  botToken?: string;
  appToken?: string;
  awaitDispatch?: boolean;
};

function withSlackDispatchLifecycle(
  args: unknown,
  abortSignal: AbortSignal,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Slack event arguments must be an object");
  }
  const eventArgs = args as Record<string, unknown>;
  const existingContext =
    eventArgs.context && typeof eventArgs.context === "object" && !Array.isArray(eventArgs.context)
      ? (eventArgs.context as Record<string, unknown>)
      : {};
  return {
    ...eventArgs,
    context: {
      ...existingContext,
      [SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY]: {
        admission: "exclusive",
        abortSignal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    },
  };
}

type SlackTestState = {
  config: Record<string, unknown>;
  appConstructorArgs?: Record<string, unknown>;
  appConstructed: ReturnType<typeof createSlackTestEvent>;
  appStarted: ReturnType<typeof createSlackTestEvent>;
  appStartMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  appStopMock: Mock<(...args: unknown[]) => Promise<unknown>>;
  httpRequestListenerMock: Mock<(...args: unknown[]) => unknown>;
  interactionRegistrations: string[];
  sendMock: Mock<typeof sendMessageSlack>;
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
  createSlackStartupAuthClientMock: Mock<SlackStartupAuthClientFactory>;
  dispatches: Set<{ controller: AbortController; run: Promise<void> }>;
};

// The runner resets this module between files, retiring Bolt clients and their mocks together.
const { state: slackTestState, transport: slackTestTransport } = vi.hoisted(
  (): {
    state: SlackTestState;
    transport: { handlers?: Map<string, SlackHandler>; client?: SlackClient };
  } => ({
    state: {
      config: {},
      appConstructorArgs: undefined,
      appConstructed: createSlackTestEvent(),
      appStarted: createSlackTestEvent(),
      appStartMock: vi.fn(),
      appStopMock: vi.fn(),
      httpRequestListenerMock: vi.fn(),
      interactionRegistrations: [],
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
      createSlackStartupAuthClientMock: vi.fn(),
      dispatches: new Set(),
    },
    transport: {},
  }),
);

export const getSlackTestState = (): SlackTestState => slackTestState;

export function useSlackStartupAuthClientOnce(factory: SlackStartupAuthClientFactory): void {
  slackTestState.createSlackStartupAuthClientMock.mockImplementationOnce(factory);
}

export const SLACK_TEST_STARTUP_AUTH_TIMEOUT_MS = 100;
export const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

export function useShortSlackStartupAuthClientOnce(): void {
  useSlackStartupAuthClientOnce(
    (token, options) =>
      new WebClient(token, {
        ...options,
        // Production timeout and retry policy are pinned in client owner tests.
        retryConfig: {
          retries: 2,
          factor: 1,
          minTimeout: 1,
          maxTimeout: 1,
          randomize: false,
        },
        timeout: SLACK_TEST_STARTUP_AUTH_TIMEOUT_MS,
      }),
  );
}

export async function runSlackHandlerWithDispatch(
  handler: SlackHandler,
  args: unknown,
): Promise<void> {
  const controller = new AbortController();
  const dispatch = {
    controller,
    run: handler(withSlackDispatchLifecycle(args, controller.signal)),
  };
  slackTestState.dispatches.add(dispatch);
  try {
    await dispatch.run;
  } finally {
    slackTestState.dispatches.delete(dispatch);
  }
}

export async function stopSlackTestDispatches(): Promise<void> {
  const dispatches = [...slackTestState.dispatches];
  for (const { controller } of dispatches) {
    controller.abort();
  }
  await Promise.allSettled(dispatches.map(({ run }) => run));
}

export async function waitForSlackTestApp(
  monitor: { run: Promise<unknown> },
  phase: "constructed" | "started",
): Promise<void> {
  // These events belong to the fixture's App; callers reset between monitors.
  const ready = phase === "constructed" ? slackTestState.appConstructed : slackTestState.appStarted;
  await Promise.race([
    ready.promise,
    monitor.run.then(() => {
      throw new Error(`Slack monitor stopped before its App was ${phase}`);
    }),
  ]);
}

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
  apiCall: Mock<(...args: unknown[]) => Promise<{ ok: boolean }>>;
  reactions: {
    add: (...args: unknown[]) => unknown;
    remove: (...args: unknown[]) => unknown;
  };
};

export const getSlackHandlers = () => ensureSlackTestRuntime().handlers;

export const getSlackClient = () => ensureSlackTestRuntime().client;

export function disposeSlackTestRuntime(): void {
  delete slackTestTransport.handlers;
  delete slackTestTransport.client;
}

function ensureSlackTestRuntime(): {
  handlers: Map<string, SlackHandler>;
  client: SlackClient;
} {
  if (!slackTestTransport.handlers) {
    slackTestTransport.handlers = new Map<string, SlackHandler>();
  }
  if (!slackTestTransport.client) {
    slackTestTransport.client = {
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
      apiCall: vi.fn().mockResolvedValue({ ok: true }),
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
  return {
    handlers: slackTestTransport.handlers,
    client: slackTestTransport.client,
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
    channelRuntime?: ChannelRuntimeSurface;
    runtime?: RuntimeEnv;
    setStatus?: (next: Record<string, unknown>) => void;
  },
) {
  const controller = new AbortController();
  const run = monitorSlackProvider({
    botToken: opts?.botToken ?? "bot-token",
    appToken: opts?.appToken ?? "app-token",
    abortSignal: controller.signal,
    config: slackTestState.config,
    channelRuntime: opts?.channelRuntime,
    runtime: opts?.runtime,
    setStatus: opts?.setStatus,
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
  // A stopped provider's handlers must not satisfy the next start's
  // waitForSlackEvent — see the reset-time clear above.
  slackTestTransport.handlers?.clear();
}

async function runSlackEventOnce(
  monitorSlackProvider: SlackProviderMonitor,
  name: string,
  args: unknown,
  opts?: SlackRunOnceOptions,
) {
  const { controller, run } = startSlackMonitor(monitorSlackProvider, opts);
  const handler = await getSlackHandlerOrThrow(name);
  // Normal Bolt handlers return after queue admission. Terminal-state tests use the
  // durable-ingress lifecycle so this helper can await the actual dispatch boundary.
  try {
    if (opts?.awaitDispatch) {
      await runSlackHandlerWithDispatch(handler, args);
    } else {
      await handler(args);
    }
  } finally {
    await stopSlackMonitor({ controller, run });
  }
}

export async function runSlackMessageOnce(
  monitorSlackProvider: SlackProviderMonitor,
  args: unknown,
  opts?: SlackRunOnceOptions,
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
      dm: { enabled: true },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
    },
  },
});

let lastSlackTestStateDir: string | undefined;

export async function resetSlackTestState(
  config: Record<string, unknown> = defaultSlackTestConfig(),
) {
  // Fresh persistent state per test: the dispatch-dedupe guard writes logical
  // message keys to the state DB, and fixture ts values repeat across tests,
  // so a carried-over DB would dedupe unrelated test messages. realpath keeps
  // macOS /var vs /private/var symlinks out of resolver assertions.
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  // Retire the previous monitor's handlers before another start can observe them.
  slackTestTransport.handlers?.clear();
  if (lastSlackTestStateDir) {
    fs.rmSync(lastSlackTestStateDir, { recursive: true, force: true });
  }
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-slack-monitor-state-")),
  );
  lastSlackTestStateDir = stateDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  setSlackRuntime({
    channel: createPluginRuntimeMock().channel,
    state: {
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
      ) =>
        createChannelIngressQueueForTests({
          ...options,
          channelId: "slack",
          stateDir: options?.stateDir ?? stateDir,
        }),
      resolveStateDir: () => stateDir,
    },
  } as unknown as PluginRuntime);
  slackTestState.config = config;
  slackTestState.appConstructorArgs = undefined;
  slackTestState.appConstructed = createSlackTestEvent();
  slackTestState.appStarted = createSlackTestEvent();
  slackTestState.socketModeLogger = undefined;
  slackTestState.appStartMock.mockReset().mockResolvedValue(undefined);
  slackTestState.appStopMock.mockReset().mockResolvedValue(undefined);
  slackTestState.httpRequestListenerMock.mockReset();
  slackTestState.interactionRegistrations.length = 0;
  slackTestState.sendMock.mockReset().mockImplementation(async (target, _text, options) => {
    const channelId = target.replace(/^channel:/, "");
    const messageId = `2000000000.${String(slackTestState.sendMock.mock.calls.length).padStart(6, "0")}`;
    const result = {
      channelId,
      messageId,
      threadTs: options.threadTs,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", channelId, messageId }],
        threadId: options.threadTs,
      }),
    };
    await options.onDeliveryResult?.(result);
    return result;
  });
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
  slackTestState.createSlackStartupAuthClientMock
    .mockReset()
    .mockReturnValue(getSlackClient() as unknown as ReturnType<SlackStartupAuthClientFactory>);
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
  client.apiCall.mockReset().mockResolvedValue({ ok: true });
  getSlackHandlers()?.clear();
}

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    readSessionUpdatedAt: vi.fn(() => undefined),
    getSessionEntry: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args: unknown[]) => slackTestState.updateLastRouteMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  type ReplyResolver = NonNullable<DispatchParams["replyResolver"]>;
  const replyResolver: ReplyResolver = (...args) =>
    slackTestState.replyMock(...args) as ReturnType<ReplyResolver>;
  return {
    ...actual,
    dispatchChannelInboundTurn: (params: DispatchParams) =>
      actual.dispatchChannelInboundTurn({ ...params, replyResolver }),
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

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createSlackStartupAuthClient: (...args: Parameters<SlackStartupAuthClientFactory>) =>
      slackTestState.createSlackStartupAuthClientMock(...args),
  };
});

vi.mock("./send.js", () => {
  return {
    sendMessageSlack: (...args: Parameters<typeof sendMessageSlack>) =>
      slackTestState.sendMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) =>
      slackTestState.readAllowFromStoreMock(...args),
    upsertChannelPairingRequest: (...args: unknown[]) =>
      slackTestState.upsertPairingRequestMock(...args),
  };
});

vi.mock("@slack/bolt", () => {
  const { handlers, client: slackClient } = ensureSlackTestRuntime();
  class App {
    client = slackClient;
    receiver: unknown;
    middlewares: SlackMiddleware[] = [];
    private readonly started = slackTestState.appStarted;

    constructor(args?: Record<string, unknown>) {
      slackTestState.appConstructorArgs = args;
      this.receiver = args?.receiver;
      slackTestState.appConstructed.resolve();
    }
    use(middleware: SlackMiddleware) {
      this.middlewares.push(middleware);
    }
    event(name: string, handler: SlackHandler) {
      handlers.set(name, async (args: unknown) => {
        const eventArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const run = async (index: number): Promise<void> => {
          const middleware = this.middlewares[index];
          if (!middleware) {
            await handler(args);
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
      slackTestState.interactionRegistrations.push("command");
    }
    action() {
      slackTestState.interactionRegistrations.push("action");
    }
    shortcut() {
      slackTestState.interactionRegistrations.push("shortcut");
    }
    view() {
      slackTestState.interactionRegistrations.push("view");
    }
    start = async (...args: unknown[]) => {
      const result = await slackTestState.appStartMock(...args);
      this.started.resolve();
      return result;
    };
    stop = (...args: unknown[]) => slackTestState.appStopMock(...args);
  }
  class HTTPReceiver {
    requestListener = (...args: unknown[]) => slackTestState.httpRequestListenerMock(...args);
  }
  class SocketModeReceiver {
    client = Object.assign(new EventEmitter(), slackClient, {
      send: vi.fn<(envelopeId: string) => Promise<void>>().mockResolvedValue(undefined),
    });

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
