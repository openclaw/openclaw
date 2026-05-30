import {
  createStartAccountContext,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildResolvedNostrAccount } from "./test-fixtures.js";
import type { ResolvedNostrAccount } from "./types.js";

const hoisted = vi.hoisted(() => ({
  startNostrBus: vi.fn(),
  busClose: vi.fn(),
  getNostrRuntime: vi.fn(),
  resolveStableChannelMessageIngress: vi.fn(),
  createChannelPairingController: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  startNostrBus: hoisted.startNostrBus,
}));

vi.mock("./runtime.js", () => ({
  getNostrRuntime: hoisted.getNostrRuntime,
}));

vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", () => ({
  resolveStableChannelMessageIngress: hoisted.resolveStableChannelMessageIngress,
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingController: hoisted.createChannelPairingController,
}));

const { startNostrGatewayAccount } = await import("./gateway.js");

function mockStartedBus() {
  hoisted.busClose.mockClear();
  const handle = {
    close: hoisted.busClose,
    sendDm: vi.fn(async () => {}),
    getMetrics: vi.fn(() => ({})),
  };
  hoisted.startNostrBus.mockResolvedValue(handle);
  hoisted.getNostrRuntime.mockReturnValue({
    channel: {
      commands: { shouldComputeCommandAuthorized: vi.fn(() => false) },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "off"),
        convertMarkdownTables: vi.fn((s: string) => s),
      },
    },
  });
  hoisted.createChannelPairingController.mockReturnValue({
    issueChallenge: vi.fn(async () => {}),
  });
  hoisted.resolveStableChannelMessageIngress.mockResolvedValue({
    senderAccess: { decision: "allow", reasonCode: "ok" },
    commandAccess: { requested: false, authorized: undefined },
  });
  return { handle };
}

function buildAccount(): ResolvedNostrAccount {
  return buildResolvedNostrAccount();
}

describe("nostr startNostrGatewayAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Regression: pre-fix, startNostrGatewayAccount returned `{ stop }`
  // synchronously, which the channel supervisor reads as
  // `channel exited without an error` and triggers an endless restart
  // loop. The bus connection also leaked because nothing wired bus.close
  // to the abort signal. Mirrors the twitch fix (#60071).
  it("keeps startAccount pending until abort, then closes the bus", async () => {
    mockStartedBus();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: startNostrGatewayAccount,
      account: buildAccount(),
    });

    await expectPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.startNostrBus),
      isSettled,
      abort,
      task,
      assertBeforeAbort: () => {
        expect(hoisted.busClose).not.toHaveBeenCalled();
      },
      assertAfterAbort: () => {
        expect(hoisted.busClose).toHaveBeenCalledOnce();
      },
    });
  });

  it("closes the bus immediately when startAccount receives an already-aborted signal", async () => {
    mockStartedBus();
    const abort = new AbortController();
    abort.abort();

    await startNostrGatewayAccount(
      createStartAccountContext({
        account: buildAccount(),
        abortSignal: abort.signal,
      }),
    );

    expect(hoisted.startNostrBus).toHaveBeenCalledOnce();
    expect(hoisted.busClose).toHaveBeenCalledOnce();
  });
});
