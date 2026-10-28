import type { webhook } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LineConfig } from "./types.js";
type DeliverFn = (
  events: readonly webhook.Event[],
  destination: string,
  control: Record<string, unknown>,
) => Promise<void>;

const { createLineWebhookSpoolMock, handleLineWebhookEventsMock } = vi.hoisted(() => ({
  createLineWebhookSpoolMock: vi.fn(),
  handleLineWebhookEventsMock: vi.fn<typeof import("./bot-handlers.js").handleLineWebhookEvents>(
    async () => {},
  ),
}));

vi.mock("./webhook-spool.js", () => ({
  createLineWebhookSpool: createLineWebhookSpoolMock,
}));
vi.mock("./bot-handlers.js", () => ({
  handleLineWebhookEvents: handleLineWebhookEventsMock,
}));

const { createLineBot } = await import("./bot.js");
const credentials = { channelAccessToken: "test-token", channelSecret: "test-secret" };

function configWith(line: LineConfig = {}, historyLimit?: number): OpenClawConfig {
  return {
    messages: { groupChat: { historyLimit } },
    channels: { line: { enabled: true, ...credentials, ...line } },
  };
}

function createDelivery(config: OpenClawConfig, accountId?: string) {
  let deliver: DeliverFn | undefined;
  createLineWebhookSpoolMock.mockImplementation((spoolOptions: { deliver: DeliverFn }) => {
    deliver = spoolOptions.deliver;
    return { accept: vi.fn(), start: vi.fn(), stop: vi.fn() };
  });

  createLineBot({
    config,
    accountId,
    runtime: createNonExitingRuntime(),
    onMessage: async () => {},
  });

  const deliverEvent = expectDefined(deliver, "spool delivery callback");
  return async () => {
    await deliverEvent([], "destination", {});
    return expectDefined(handleLineWebhookEventsMock.mock.calls.at(-1)?.[1], "handler context");
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});
afterEach(() => clearRuntimeConfigSnapshot());

it.each([
  { mediaMaxMb: 0, expected: 10 },
  { mediaMaxMb: undefined, expected: 10 },
  { mediaMaxMb: 2, expected: 2 },
])("resolves mediaMaxMb=$mediaMaxMb to $expected MB", async ({ mediaMaxMb, expected }) => {
  expect((await createDelivery(configWith({ mediaMaxMb }))()).mediaMaxBytes).toBe(
    expected * 1024 * 1024,
  );
});
it.each([
  [20, 3, 3],
  [20, undefined, 20],
  [undefined, undefined, 7],
  [20, 0, 0],
])("resolves root %s/account %s history to %s", async (root, historyLimit, expected) => {
  const cfg = configWith(
    {
      ...(root === undefined ? {} : { historyLimit: root }),
      accounts: { work: historyLimit === undefined ? {} : { historyLimit } },
    },
    7,
  );
  expect((await createDelivery(cfg, "work")()).historyLimit).toBe(expected);
});
it("follows a reload for a monitor the Gateway started from the process config", async () => {
  const startupConfig = configWith({}, 10);
  setRuntimeConfigSnapshot(startupConfig, configWith({}, 10));
  const deliver = createDelivery(startupConfig);
  const reloaded = configWith({}, 75);
  setRuntimeConfigSnapshot(reloaded, configWith({}, 75));
  const handled = await deliver();
  expect(handled.historyLimit).toBe(75);
  expect(handled.cfg).toBe(reloaded);
});
it("passes the webhook destination on as the receiving bot's user id", async () => {
  expect((await createDelivery(configWith({}))()).botUserId).toBe("destination");
});

it.each(["with source", "without source", "absent"])(
  "keeps its own config when the startup process snapshot is %s",
  async (snapshot) => {
    const ownConfig = configWith({}, 10);
    const startupRuntime = configWith({}, 33);
    if (snapshot !== "absent") {
      setRuntimeConfigSnapshot(
        startupRuntime,
        ...(snapshot === "with source" ? [startupRuntime] : []),
      );
    }
    const deliver = createDelivery(ownConfig);
    setRuntimeConfigSnapshot(configWith({}, 75), configWith({}, 75));
    const handled = await deliver();
    expect(handled.historyLimit).toBe(10);
    expect(handled.cfg).toBe(ownConfig);
  },
);

it("keeps the account's own history limit ahead of the reloaded shared default", async () => {
  const startupConfig = configWith({ historyLimit: 5 }, 10);
  setRuntimeConfigSnapshot(startupConfig, startupConfig);
  const deliver = createDelivery(startupConfig);
  setRuntimeConfigSnapshot(configWith({}, 75), configWith({}, 75));
  expect((await deliver()).historyLimit).toBe(5);
});
