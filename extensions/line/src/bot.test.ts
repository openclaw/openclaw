import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const MB = 1024 * 1024;

function configWith(mediaMaxMb?: number): OpenClawConfig {
  return {
    channels: {
      line: {
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
      },
    },
  } as OpenClawConfig;
}

// Exercise the spool-to-handler boundary rather than the private cap calculation.
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

async function resolveMediaMaxBytes(mediaMaxMb?: number) {
  return (await createDelivery(configWith(mediaMaxMb))()).mediaMaxBytes;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});
afterEach(() => clearRuntimeConfigSnapshot());

describe("createLineBot media cap", () => {
  it.each([
    { mediaMaxMb: 0, label: "zero" },
    { mediaMaxMb: -5, label: "negative" },
  ])("treats a $label mediaMaxMb as unset instead of a 0-byte cap", async ({ mediaMaxMb }) => {
    // A non-positive cap would otherwise reject every non-empty inbound download.
    await expect(resolveMediaMaxBytes(mediaMaxMb)).resolves.toBe(10 * MB);
  });

  it("keeps the default when mediaMaxMb is unset", async () => {
    await expect(resolveMediaMaxBytes()).resolves.toBe(10 * MB);
  });

  it("still caps at a configured positive mediaMaxMb", async () => {
    await expect(resolveMediaMaxBytes(2)).resolves.toBe(2 * MB);
  });
});

describe("createLineBot pending history cap", () => {
  it.each([
    { root: 20, account: 3, expected: 3 },
    { root: 20, account: undefined, expected: 20 },
    { root: undefined, account: undefined, expected: 7 },
    { root: 20, account: 0, expected: 0 },
  ])("resolves account $account then root $root before the global fallback", async (testCase) => {
    const context = await createDelivery(
      {
        messages: { groupChat: { historyLimit: 7 } },
        channels: {
          line: {
            ...configWith().channels?.line,
            ...(testCase.root === undefined ? {} : { historyLimit: testCase.root }),
            accounts: {
              work: testCase.account === undefined ? {} : { historyLimit: testCase.account },
            },
          },
        },
      } as unknown as OpenClawConfig,
      "work",
    )();
    expect(context.historyLimit).toBe(testCase.expected);
  });
});

function configWithHistoryLimit(historyLimit: number, accountLimit?: number): OpenClawConfig {
  return {
    channels: {
      line: {
        ...configWith().channels?.line,
        ...(accountLimit === undefined ? {} : { historyLimit: accountLimit }),
      },
    },
    messages: { groupChat: { historyLimit } },
  } as OpenClawConfig;
}

describe("the config a delivered LINE event is handled with", () => {
  it("follows a reload for a monitor the Gateway started from the process config", async () => {
    const startupConfig = configWithHistoryLimit(10);
    setRuntimeConfigSnapshot(startupConfig, configWithHistoryLimit(10));
    const deliver = createDelivery(startupConfig);
    const reloaded = configWithHistoryLimit(75);
    setRuntimeConfigSnapshot(reloaded, configWithHistoryLimit(75));
    const handled = await deliver();
    expect(handled.cfg).toBe(reloaded);
    expect(handled.historyLimit).toBe(75);
  });

  // A distinct supplied config is scoped, including when the source snapshot is absent.
  it.each([true, false])(
    "keeps its own config when the process snapshot has source=%s",
    async (withSource) => {
      const ownConfig = configWithHistoryLimit(10);
      const startupRuntime = configWithHistoryLimit(33);
      setRuntimeConfigSnapshot(startupRuntime, ...(withSource ? [startupRuntime] : []));
      const deliver = createDelivery(ownConfig);
      setRuntimeConfigSnapshot(configWithHistoryLimit(75), configWithHistoryLimit(75));
      const handled = await deliver();
      expect(handled.cfg).toBe(ownConfig);
      expect(handled.historyLimit).toBe(10);
    },
  );

  it("keeps a supplied config when the process snapshot appears after startup", async () => {
    const ownConfig = configWithHistoryLimit(10);
    const deliver = createDelivery(ownConfig);
    setRuntimeConfigSnapshot(configWithHistoryLimit(75), configWithHistoryLimit(75));
    const handled = await deliver();
    expect(handled.cfg).toBe(ownConfig);
    expect(handled.historyLimit).toBe(10);
  });

  it("keeps the account's own history limit ahead of the reloaded shared default", async () => {
    const startupConfig = configWithHistoryLimit(10, 5);
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const deliver = createDelivery(startupConfig);
    setRuntimeConfigSnapshot(configWithHistoryLimit(75), configWithHistoryLimit(75));
    expect((await deliver()).historyLimit).toBe(5);
  });
});
