import { vi } from "vitest";
const slackTestState = vi.hoisted(() => ({
  config: {},
  sendMock: vi.fn(),
  replyMock: vi.fn(),
  updateLastRouteMock: vi.fn(),
  reactMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn()
}));
const getSlackTestState = () => slackTestState;
const getSlackHandlers = () => ensureSlackTestRuntime().handlers;
const getSlackClient = () => ensureSlackTestRuntime().client;
function ensureSlackTestRuntime() {
  const globalState = globalThis;
  if (!globalState.__slackHandlers) {
    globalState.__slackHandlers = /* @__PURE__ */ new Map();
  }
  if (!globalState.__slackClient) {
    globalState.__slackClient = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: "bot-user" }) },
      conversations: {
        info: vi.fn().mockResolvedValue({
          channel: { name: "dm", is_im: true }
        }),
        replies: vi.fn().mockResolvedValue({ messages: [] }),
        history: vi.fn().mockResolvedValue({ messages: [] })
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { profile: { display_name: "Ada" } }
        })
      },
      assistant: {
        threads: {
          setStatus: vi.fn().mockResolvedValue({ ok: true })
        }
      },
      reactions: {
        add: (...args) => slackTestState.reactMock(...args)
      }
    };
  }
  return {
    handlers: globalState.__slackHandlers,
    client: globalState.__slackClient
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitForSlackEvent(name) {
  for (let i = 0; i < 10; i += 1) {
    if (getSlackHandlers()?.has(name)) {
      return;
    }
    await flush();
  }
}
function startSlackMonitor(monitorSlackProvider, opts) {
  const controller = new AbortController();
  const run = monitorSlackProvider({
    botToken: opts?.botToken ?? "bot-token",
    appToken: opts?.appToken ?? "app-token",
    abortSignal: controller.signal,
    config: slackTestState.config
  });
  return { controller, run };
}
async function getSlackHandlerOrThrow(name) {
  await waitForSlackEvent(name);
  const handler = getSlackHandlers()?.get(name);
  if (!handler) {
    throw new Error(`Slack ${name} handler not registered`);
  }
  return handler;
}
async function stopSlackMonitor(params) {
  await flush();
  params.controller.abort();
  await params.run;
}
async function runSlackEventOnce(monitorSlackProvider, name, args, opts) {
  const { controller, run } = startSlackMonitor(monitorSlackProvider, opts);
  const handler = await getSlackHandlerOrThrow(name);
  await handler(args);
  await stopSlackMonitor({ controller, run });
}
async function runSlackMessageOnce(monitorSlackProvider, args, opts) {
  await runSlackEventOnce(monitorSlackProvider, "message", args, opts);
}
const defaultSlackTestConfig = () => ({
  messages: {
    responsePrefix: "PFX",
    ackReaction: "\u{1F440}",
    ackReactionScope: "group-mentions"
  },
  channels: {
    slack: {
      dm: { enabled: true, policy: "open", allowFrom: ["*"] },
      groupPolicy: "open"
    }
  }
});
function resetSlackTestState(config = defaultSlackTestConfig()) {
  slackTestState.config = config;
  slackTestState.sendMock.mockReset().mockResolvedValue(void 0);
  slackTestState.replyMock.mockReset();
  slackTestState.updateLastRouteMock.mockReset();
  slackTestState.reactMock.mockReset();
  slackTestState.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  slackTestState.upsertPairingRequestMock.mockReset().mockResolvedValue({
    code: "PAIRCODE",
    created: true
  });
  getSlackHandlers()?.clear();
}
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => slackTestState.config
  };
});
vi.mock("../../../src/auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args) => slackTestState.replyMock(...args)
}));
vi.mock("./resolve-channels.js", () => ({
  resolveSlackChannelAllowlist: async ({ entries }) => entries.map((input) => ({ input, resolved: false }))
}));
vi.mock("./resolve-users.js", () => ({
  resolveSlackUserAllowlist: async ({ entries }) => entries.map((input) => ({ input, resolved: false }))
}));
vi.mock("./send.js", () => ({
  sendMessageSlack: (...args) => slackTestState.sendMock(...args)
}));
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args) => slackTestState.readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args) => slackTestState.upsertPairingRequestMock(...args)
}));
vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args) => slackTestState.updateLastRouteMock(...args),
    resolveSessionKey: vi.fn(),
    readSessionUpdatedAt: vi.fn(() => void 0),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(void 0)
  };
});
vi.mock("@slack/bolt", () => {
  const { handlers, client: slackClient } = ensureSlackTestRuntime();
  class App {
    constructor() {
      this.client = slackClient;
      this.start = vi.fn().mockResolvedValue(void 0);
      this.stop = vi.fn().mockResolvedValue(void 0);
    }
    event(name, handler) {
      handlers.set(name, handler);
    }
    command() {
    }
  }
  class HTTPReceiver {
    constructor() {
      this.requestListener = vi.fn();
    }
  }
  return { App, HTTPReceiver, default: { App, HTTPReceiver } };
});
export {
  defaultSlackTestConfig,
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackEventOnce,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
  waitForSlackEvent
};
