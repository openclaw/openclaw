/**
 * REAL BEHAVIOR PROOF (not a mocked-transport unit test).
 *
 * Every other test in this directory mocks `../send-reactions.js` — the very module
 * whose caller decides whether a reaction is sent. That proves nothing about the
 * production receive -> reaction transport path.
 *
 * This harness mocks ONLY the lowest layer: the signal-cli JSON-RPC HTTP boundary
 * (`./client.js`'s `signalRpcRequest`). Everything above it is REAL production code:
 *
 *   createSignalEventHandler()(receiveEvent)      <- real receive ingest
 *     -> real status-reaction controller
 *       -> real sendReactionSignal()
 *         -> real sendReactionSignalCore()       <- validation + request assembly
 *           -> (stubbed HTTP boundary, records the outbound JSON-RPC request)
 *
 * The assertion is therefore made on the JSON-RPC request the production stack
 * actually assembles and hands to the transport — the observed wire payload.
 *
 * Run (needs a runtime whose node:sqlite >= 3.51.3, e.g. Node 24.16+):
 *   node node_modules/vitest/vitest.mjs run <this file> --project extension-signal
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcCalls = vi.hoisted(() => [] as Array<{ method: string; params: Record<string, unknown> }>);

// Stub the HTTP boundary only. `sendReactionSignal` and its core remain real.
vi.mock("../client.js", () => ({
  signalRpcRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
    rpcCalls.push({ method, params: params ?? {} });
    return { timestamp: 1700000000000 };
  }),
  signalCheck: vi.fn(async () => ({ ok: true, status: 200 })),
  streamSignalEvents: vi.fn(async () => {}),
}));

vi.mock("../client-container.js", () => ({
  containerRpcRequest: vi.fn(async () => ({ timestamp: 1700000000000 })),
  containerCheck: vi.fn(async () => ({ ok: true, status: 200 })),
  streamContainerEvents: vi.fn(async () => {}),
}));

// The agent turn is orthogonal to the reaction transport under test. Without this the
// real dispatch path blocks on workspace/agent roster resolution and never settles.
vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }),
    dispatchInboundMessageWithDispatcher: async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }),
    dispatchInboundMessageWithBufferedDispatcher: async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }),
  };
});

const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./event-handler.test-harness.js");
const { createSignalEventHandler } = await import("./event-handler.js");
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("openclaw/plugin-sdk/runtime-config-snapshot");

const statusReactionTiming = {
  debounceMs: 0,
  doneHoldMs: 0,
  errorHoldMs: 0,
  stallSoftMs: 60_000,
  stallHardMs: 120_000,
};

function createStatusReactionGroupConfig(): OpenClawConfig {
  return {
    messages: {
      inbound: { debounceMs: 0 },
      ackReaction: "👀",
      ackReactionScope: "group-all",
      statusReactions: { enabled: true, timing: { ...statusReactionTiming } },
    },
    channels: {
      signal: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["group:g1"],
        groups: { g1: { requireMention: false } },
      },
    },
  } as unknown as OpenClawConfig;
}

function createGroupHandler() {
  const cfg = createStatusReactionGroupConfig();
  setRuntimeConfigSnapshot(cfg);
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      historyLimit: 0,
      cfg,
      groupPolicy: "allowlist",
      groupAllowFrom: ["group:g1"],
      statusReactionTiming: { ...statusReactionTiming },
    }),
  );
}

async function receiveGroupMessage(timestamp: number) {
  const handler = createGroupHandler();
  // The receive turn may not settle on every path (the drop path leaves admission pending);
  // the reaction transport is what this proof observes, so do not block on it.
  void handler(
    createSignalReceiveEvent({
      sourceNumber: "+15550002222",
      sourceName: "Bob",
      timestamp,
      dataMessage: {
        message: "ship it",
        attachments: [],
        groupInfo: { groupId: "g1", groupName: "Test Group" },
      },
    }),
  ).catch(() => {});
  // Let ingest reach the status-reaction controller and flush through the real transport.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 3_000);
  });
}

function observedReactionTargets(): unknown[] {
  return rpcCalls
    .filter((call) => call.method === "sendReaction")
    .map((call) => call.params.targetTimestamp);
}

describe("signal receive -> reaction transport (real path)", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    clearRuntimeConfigSnapshot();
  });

  it("issues NO sendReaction RPC for a fractional inbound timestamp", async () => {
    await receiveGroupMessage(1.5);

    expect(observedReactionTargets()).toEqual([]);
  });

  it("DOES issue sendReaction RPC for a canonical integer inbound timestamp", async () => {
    await receiveGroupMessage(1700000000002);

    expect(observedReactionTargets()).toContain(1700000000002);
    // The real transport assembled a complete signal-cli request.
    const first = rpcCalls.find((call) => call.method === "sendReaction");
    expect(first?.params).toMatchObject({
      targetTimestamp: 1700000000002,
      targetAuthor: "+15550002222",
      groupIds: ["g1"],
    });
  });
  it("never sends a non-integer targetTimestamp on the reaction transport", async () => {
    await receiveGroupMessage(1.5);
    await receiveGroupMessage(1700000000002);

    for (const target of observedReactionTargets()) {
      expect(Number.isSafeInteger(target)).toBe(true);
    }
  });
});
