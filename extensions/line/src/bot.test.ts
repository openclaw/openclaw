import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineConfig } from "./types.js";

type DeliverFn = (
  events: readonly webhook.Event[],
  destination: string,
  control: Record<string, unknown>,
) => Promise<void>;

const { createLineWebhookSpoolMock, handleLineWebhookEventsMock } = vi.hoisted(() => ({
  createLineWebhookSpoolMock: vi.fn(),
  handleLineWebhookEventsMock: vi.fn(
    async (
      _events: webhook.Event[],
      _context: { cfg: OpenClawConfig; mediaMaxBytes: number; historyLimit: number },
    ) => {},
  ),
}));

vi.mock("./webhook-spool.js", () => ({
  createLineWebhookSpool: createLineWebhookSpoolMock,
}));
vi.mock("./bot-handlers.js", () => ({
  handleLineWebhookEvents: handleLineWebhookEventsMock,
}));

const { createLineBot } = await import("./bot.js");

function configWith(line: LineConfig = {}, historyLimit?: number): OpenClawConfig {
  return {
    ...(historyLimit === undefined ? {} : { messages: { groupChat: { historyLimit } } }),
    channels: {
      line: {
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        ...line,
      },
    },
  } as OpenClawConfig;
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

  if (!deliver) {
    throw new Error("createLineBot did not build a spool deliver callback");
  }
  const deliverEvent = deliver;
  return async () => {
    await deliverEvent([{ type: "message" } as webhook.Event], "destination", {});
    const context = handleLineWebhookEventsMock.mock.calls.at(-1)?.[1];
    if (!context) {
      throw new Error("handleLineWebhookEvents was not called");
    }
    return context;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});
afterEach(() => clearRuntimeConfigSnapshot());

describe("createLineBot media cap", () => {
  it.each([
    { mediaMaxMb: 0, expected: 10 },
    { mediaMaxMb: -5, expected: 10 },
    { mediaMaxMb: undefined, expected: 10 },
    { mediaMaxMb: 2, expected: 2 },
  ])("resolves mediaMaxMb=$mediaMaxMb to $expected MB", async ({ mediaMaxMb, expected }) => {
    expect((await createDelivery(configWith({ mediaMaxMb }))()).mediaMaxBytes).toBe(
      expected * 1024 * 1024,
    );
  });
});

describe("createLineBot pending history cap", () => {
  it.each([
    { root: 20, account: 3, expected: 3 },
    { root: 20, account: undefined, expected: 20 },
    { root: undefined, account: undefined, expected: 7 },
    { root: 20, account: 0, expected: 0 },
  ])(
    "resolves account $account then root $root before the global fallback",
    async ({ root, account, expected }) => {
      const context = await createDelivery(
        configWith(
          {
            ...(root === undefined ? {} : { historyLimit: root }),
            accounts: { work: account === undefined ? {} : { historyLimit: account } },
          },
          7,
        ),
        "work",
      )();
      expect(context.historyLimit).toBe(expected);
    },
  );
});

describe("the config a delivered LINE event is handled with", () => {
  it("follows a reload for a monitor the Gateway started from the process config", async () => {
    const startupConfig = configWith({}, 10);
    setRuntimeConfigSnapshot(startupConfig, configWith({}, 10));
    const deliver = createDelivery(startupConfig);
    const reloaded = configWith({}, 75);
    setRuntimeConfigSnapshot(reloaded, configWith({}, 75));
    const handled = await deliver();
    expect(handled.cfg).toBe(reloaded);
    expect(handled.historyLimit).toBe(75);
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
      expect(handled.cfg).toBe(ownConfig);
      expect(handled.historyLimit).toBe(10);
    },
  );

  it("keeps the account's own history limit ahead of the reloaded shared default", async () => {
    const startupConfig = configWith({ historyLimit: 5 }, 10);
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const deliver = createDelivery(startupConfig);
    setRuntimeConfigSnapshot(configWith({}, 75), configWith({}, 75));
    expect((await deliver()).historyLimit).toBe(5);
  });
});
