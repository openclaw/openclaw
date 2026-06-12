// Live-proof harness for PR #83738 (cron wake origin capture).
//
// Drives the patched gateway wake handler (validateWakeParams + isSubagentSessionKey
// guard) into the patched cron service wake() (wake.ts) with deps wired to LOG
// every enqueueSystemEvent / requestHeartbeat call. Captures stdout that
// demonstrates a non-main cron wake routing to the originating session/agent
// rather than the heartbeat/main default.
//
// Run: pnpm exec tsx scripts/proof-cron-wake-origin.mts
//
// All identifiers in this script are synthetic. Real Telegram chat ids /
// session keys are not used.

import { cronHandlers } from "../src/gateway/server-methods/cron.js";
import { wake as cronServiceWake } from "../src/cron/service/wake.js";
import type { CronServiceState } from "../src/cron/service/state.js";

type EnqueueArgs = [string, { sessionKey?: string; agentId?: string } | undefined];
type HeartbeatArgs = [
  { source: string; intent: string; reason: string; sessionKey?: string; agentId?: string },
];

const log = (...parts: unknown[]) => {
  console.log(...parts);
};

function makeShimmedState(): {
  state: CronServiceState;
  recorder: { enqueue: EnqueueArgs[]; heartbeat: HeartbeatArgs[] };
} {
  const recorder = { enqueue: [] as EnqueueArgs[], heartbeat: [] as HeartbeatArgs[] };
  const state = {
    deps: {
      enqueueSystemEvent: (...args: EnqueueArgs) => {
        recorder.enqueue.push(args);
        const [text, opts] = args;
        log(
          `[gateway/cron] enqueueSystemEvent  text=${JSON.stringify(text)}  opts=${JSON.stringify(opts)}`,
        );
      },
      requestHeartbeat: (...args: HeartbeatArgs) => {
        recorder.heartbeat.push(args);
        log(`[gateway/heartbeat] requestHeartbeat  ${JSON.stringify(args[0])}`);
      },
    },
  } as unknown as CronServiceState;
  return { state, recorder };
}

type ScenarioResult = { ok: boolean; payload?: unknown; error?: unknown };

async function drive(label: string, params: unknown): Promise<ScenarioResult> {
  log("");
  log(`=== ${label} ===`);
  log(`> wake params: ${JSON.stringify(params)}`);
  const { state } = makeShimmedState();
  let response: ScenarioResult = { ok: false };
  const respond = (ok: boolean, payload: unknown, error: unknown) => {
    response = { ok, payload, error };
  };
  const context = {
    cron: {
      wake: (
        opts: {
          mode: "now" | "next-heartbeat";
          text: string;
          sessionKey?: string;
          agentId?: string;
        },
      ) => cronServiceWake(state, opts),
    },
  } as unknown as Parameters<typeof cronHandlers.wake>[0]["context"];

  // cronHandlers.wake is sync (calls respond synchronously) but typed as
  // returning void; await on a Promise wrapper to flush console.log ordering.
  await Promise.resolve(
    cronHandlers.wake({
      params,
      respond,
      context,
      request: {} as never,
      requestId: 1 as never,
      logger: undefined as never,
    } as never),
  );
  log(`< wake result:  ok=${response.ok}  payload=${JSON.stringify(response.payload)}`);
  if (response.error) {
    log(`< wake error:   ${JSON.stringify(response.error)}`);
  }
  return response;
}

async function main() {
  log("=== PR #83738 cron wake origin-capture: live-proof harness ===");
  log("Driving the patched gateway wake handler through cron.wake() with");
  log("logging deps. All ids below are synthetic.");

  // Scenario 1: real-world bug-reproduction case — a wake fired from inside
  // a non-main Telegram topic session for a non-default agent.
  await drive("non-main session + non-default agent (the bug-fix case)", {
    mode: "now",
    text: "follow up on report",
    sessionKey: "agent:coding:telegram:<chat-id-redacted>:topic:<topic-id-redacted>",
    agentId: "coding",
  });

  // Scenario 2: backwards-compatible — no origin → default routing.
  await drive("no origin (backwards-compatible default routing)", {
    mode: "now",
    text: "ping",
  });

  // Scenario 3: next-heartbeat + sessionKey collapses to a targeted-immediate
  // heartbeat because the regularly-scheduled heartbeat fires for the
  // agent's main session, never peeking the targeted lane's queue.
  await drive("next-heartbeat + sessionKey collapses to targeted-immediate", {
    mode: "next-heartbeat",
    text: "check the queue",
    sessionKey: "agent:coding:discord:<thread-redacted>",
    agentId: "coding",
  });

  // Scenario 4: subagent sessionKey rejected at the gateway handler.
  await drive("subagent sessionKey rejected by gateway handler guard", {
    mode: "now",
    text: "wake my subagent",
    sessionKey: "subagent:scratch:<id-redacted>",
  });

  // Scenario 5: whitespace-only origin falls through to default routing.
  await drive("whitespace-only origin falls through (defence-in-depth)", {
    mode: "now",
    text: "x",
    sessionKey: "   ",
    agentId: "\t",
  });

  log("");
  log("=== Done. ===");
}

void main();
