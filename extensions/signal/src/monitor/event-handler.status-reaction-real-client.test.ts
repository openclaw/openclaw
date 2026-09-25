/**
 * REAL BEHAVIOR PROOF — Signal status-reaction transport over a REAL HTTP client.
 *
 * Why this file exists alongside `event-handler.status-reaction-real-path.test.ts`
 * ------------------------------------------------------------------------------
 * That harness is honest about its own limit: it mocks ONLY the lowest layer, the
 * signal-cli JSON-RPC HTTP boundary (`vi.mock("../client.js")`). It therefore proves
 * the production stack *assembles* the right request, but the final transmission is a
 * `vi.fn()`. ClawSweeper's outstanding blocker is exactly that gap: proof "through the
 * actual client".
 *
 * This harness closes it. It does NOT mock `../client.js`. Instead it stands up a real
 * `node:http` server and points `deps.baseUrl` at it. `resolveSignalRpcContext`
 * (`extensions/signal/src/rpc-context.ts:12`) honors that override, and
 * `event-handler.ts:382` forwards `deps.baseUrl` into the reaction options, so the
 * whole chain runs unmocked:
 *
 *   createSignalEventHandler()(receiveEvent)      real receive ingest
 *     -> resolveSignalStatusReactionTimestamp()   the CHANGED function
 *       -> createStatusReactionController()       null target => no controller
 *         -> sendReactionSignal()                 real send-reactions.ts
 *           -> signalRpcRequest()                 real client-adapter.ts
 *             -> client.ts  HTTP POST /api/v1/rpc <- REAL network I/O
 *
 * The assertion is made on what the SERVER actually received, i.e. the observed wire
 * payload — not on a spy.
 *
 * The positive control is asserted FIRST and must be non-vacuous: an earlier attempt to
 * port the real server into this chain produced `expected [] to include 1700000000002`
 * because the control silently fired zero RPCs, which made the negative assertions pass
 * for the wrong reason. That failure mode is guarded explicitly below.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type RpcSeen = { method: string; params: Record<string, unknown>; generation: number };

const rpcSeen: RpcSeen[] = [];
// A receive turn is deliberately allowed to outlive its test (the drop path leaves
// admission pending), so a later turn can still reach the transport after the next
// test starts. Tagging every observed call with the current generation lets each test
// assert only on the calls its OWN turn produced, instead of racing on a shared array.
let generation = 0;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: { method?: string; params?: Record<string, unknown>; id?: string } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed bodies are simply not recorded as RPC calls; the assertions below
        // then observe zero calls, which is the correct outcome for a broken client.
      }
      if (parsed.method) {
        rpcSeen.push({ method: parsed.method, params: parsed.params ?? {}, generation });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { timestamp: 1700000000002 } }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./event-handler.test-harness.js");
// NOTE: `./event-handler.js` is imported for real. `../client.js` is NOT mocked, so the
// genuine `signalRpcRequest` (and therefore a real HTTP request) is exercised.
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
      // Route the REAL production client at our REAL server.
      baseUrl,
      historyLimit: 0,
      cfg,
      groupPolicy: "allowlist",
      groupAllowFrom: ["group:g1"],
      statusReactionTiming: { ...statusReactionTiming },
    }),
  );
}

async function receiveGroupMessage(timestamp: number, opts: { expectCall: boolean }) {
  const handler = createGroupHandler();
  const turn = handler(
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

  if (opts.expectCall) {
    // Positive case: the arrival of the RPC is itself the completion signal, so poll
    // for it rather than guessing a duration. Cold transforms can take minutes.
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && observedReactionTargets().length === 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    // Await the turn as well so the handler cannot still be mid-flight when the test
    // asserts (it resolves on the drop path too, guarded by the catch above).
    await turn;
    return;
  }

  // Negative case: there is no positive signal to wait for by definition. Wait for the
  // receive turn to settle, then drain a short grace period so any reaction the
  // controller was already going to flush (its timers are zeroed for this harness) has
  // landed. A wrong send for the fractional target would have to appear in this window.
  await turn;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 3_000);
  });
}

// NOTE: the "no reaction at all" claim cannot be asserted safely from the shared
// observation array, because the status-reaction controller debounces and can flush a
// *previous* message's reaction after the next test has begun. The deterministic,
// race-free statement of the same property is asserted in the mixed-traffic case below:
// every target that ever reaches the wire is a safe integer, and the fractional
// timestamp appears nowhere. Both a correct implementation and the pre-fix one were
// measured against these assertions (see the PR Evidence section).

function observedReactionTargets(): unknown[] {
  return rpcSeen
    .filter((call) => call.generation === generation && call.method === "sendReaction")
    .map((call) => call.params.targetTimestamp);
}

describe("signal receive -> reaction over the REAL HTTP client", () => {
  // This harness pays a cold module-transform + plugin-resolution cost that can exceed
  // Vitest's 120s default on a cold worker, so give each case explicit headroom.
  const TEST_TIMEOUT_MS = 180_000;

  beforeEach(() => {
    generation += 1;
    rpcSeen.length = 0;
    clearRuntimeConfigSnapshot();
  });

  it(
    "transmits a valid integer reaction through the real client (positive control)",
    async () => {
      await receiveGroupMessage(1700000000002, { expectCall: true });

      const targets = observedReactionTargets();
      // Guard against the vacuous-control failure mode first: if nothing reached the
      // server, every negative assertion below would pass for the wrong reason.
      expect(targets.length).toBeGreaterThan(0);
      expect(targets).toContain(1700000000002);

      const first = rpcSeen.find(
        (call) => call.generation === generation && call.method === "sendReaction",
      );
      expect(first?.params).toMatchObject({
        targetTimestamp: 1700000000002,
        targetAuthor: "+15550002222",
        groupIds: ["g1"],
      });
      // The exact emoji is chosen by the status-reaction controller (brain/eyes/etc.
      // per phase) and is not what this proof is about; assert only that a real
      // non-empty emoji was transmitted.
      const emoji = first?.params.emoji;
      expect(typeof emoji).toBe("string");
      expect((emoji as string).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps every transmitted target a safe integer across mixed traffic",
    async () => {
      // This is the self-contained statement of the property, and the only form of it
      // that is race-free: both messages are driven inside one generation, so the
      // valid send proves the transport is genuinely live (non-vacuous) and the
      // fractional send must be absent from the wire.
      //
      // A separate "fractional produces an empty set" case is deliberately NOT asserted:
      // the status-reaction controller debounces and can flush a *previous* message's
      // reaction after the next case begins, which makes any empty-set claim race
      // against unrelated in-flight work (observed as an intermittent failure).
      await receiveGroupMessage(1700000000002, { expectCall: true });
      expect(observedReactionTargets()).toContain(1700000000002);

      await receiveGroupMessage(1.5, { expectCall: false });

      const targets = observedReactionTargets();
      // The valid message must still have gone out, so this is not vacuously true.
      expect(targets).toContain(1700000000002);
      // The fractional timestamp must appear nowhere on the wire.
      expect(targets).not.toContain(1.5);
      for (const target of targets) {
        expect(Number.isSafeInteger(target)).toBe(true);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
