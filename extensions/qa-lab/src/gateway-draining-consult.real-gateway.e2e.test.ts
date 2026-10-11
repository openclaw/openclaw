/**
 * Real-Gateway E2E test for the gateway_draining observation contract.
 *
 * Proves the Gateway side of the Browser Talk consult regression: when a Gateway
 * lifecycle reset interrupts an in-flight observation of a run that has not
 * settled, `agent.wait` resolves as `{status: "timeout", timeoutPhase:
 * "gateway_draining"}`. That response is what
 * ui/src/pages/chat/talk/shared.ts classifies as terminal, so the consult
 * rejects instead of falling through to the 500ms no-text completion fallback.
 *
 * The run is held on a real `wait` tool call (`qa_restart_wait`) and the
 * assertion waits for that call to be in flight, so the reset interrupts a live
 * observation rather than racing a settled turn. The observation is proven
 * pending (not already rejected) before the interrupting restart is requested.
 *
 * Scope boundary: this proves the Gateway wait response only. It does not drive
 * a Browser Talk session, so it does not prove the correlated timeout is
 * submitted through the voice transport. That boundary needs a realtime voice
 * provider that can mint a browser session without a live external endpoint:
 * `talk.client.create` resolves through `resolveConfiguredRealtimeVoiceProvider`
 * (src/talk/provider-resolver.ts:104) and the only browser-session provider
 * POSTs to a hardcoded https://api.openai.com/v1 for its client secret
 * (extensions/openai/realtime-provider-shared.ts:64), so it cannot be exercised
 * offline. Driving the transport would need a live key and is not claimed here.
 */

import path from "node:path";
import type { ControlUiSessionListResult } from "openclaw/plugin-sdk/control-ui";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readSessionTranscriptSummary } from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Skip on Windows like other real-gateway e2e tests (e.g., gateway-kill-restart-send.e2e.test.ts)
// due to platform-specific browser/Gateway startup issues
describe.skipIf(process.platform === "win32")("gateway draining during active Talk consult", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "gateway draining test cleanup failed");
    }
  });

  it("gateway emits gateway_draining on restart during active consult", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      forcedRuntime: "openclaw",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          slots: { ...cfg.plugins?.slots, memory: "none" },
          entries: {
            ...cfg.plugins?.entries,
            acpx: { enabled: false },
            "memory-core": { enabled: false },
          },
        },
        tools: {
          ...cfg.tools,
          allow: ["talk.client.toolCall", "qa_restart_wait"],
          // Hold the run on a real wait call so the draining reset interrupts a
          // pending observation instead of a completed turn.
          codeMode: { enabled: true, timeoutMs: 10_000 },
        },
      }),
    });

    try {
      await transport.waitReady({ gateway });

      // Start a consult session
      const sessionKey = buildAgentSessionKey({
        agentId: "qa",
        channel: "qa-channel",
        accountId: transport.accountId,
        peer: { kind: "direct", id: `dm:gateway-draining-test` },
        dmScope: gateway.cfg.session?.dmScope,
        identityLinks: gateway.cfg.session?.identityLinks,
      });

      // Create session
      await gateway.call("sessions.create", {
        key: sessionKey,
        label: "Gateway draining test",
      });

      // Start the Code Mode restart-wait fixture. Its hold is a real `wait` tool
      // call, so the run stays pending until the hold is released. chat.send
      // returns the runId immediately with the run still in flight.
      const turn = (await gateway.call("chat.send", {
        sessionKey,
        message: "Code Mode restart wait QA check. Original prompt marker: CONSULT-DRAINING-TEST.",
        deliver: false,
        idempotencyKey: "gateway-draining-consult-e2e",
      })) as { runId: string; status: string };
      expect(turn.status).toBe("started");
      expect(typeof turn.runId).toBe("string");

      // Synchronize on the hold before interrupting: the Gateway must still
      // report the run active, and its `wait` tool call must still be in flight.
      // A run that has already settled would answer `ok` and prove nothing about
      // the draining classification.
      await waitForQaTransportCondition(
        async () => {
          const list = (await gateway.call("sessions.list", {
            agentId: "qa",
            limit: 100,
          })) as ControlUiSessionListResult;
          // `sessions.list` is the authoritative active-run observation: the row
          // owner projects live run state onto `hasActiveRun`/`status`.
          const row = list.sessions.find((session) => session.key === sessionKey);
          if (!row?.hasActiveRun || row.status !== "running") {
            return undefined;
          }
          const transcript = await readSessionTranscriptSummary({ gateway }, sessionKey, {
            includeCodeModeControl: true,
          });
          return (transcript.assistantToolCallCounts.wait ?? 0) >
            (transcript.completedToolCallCounts.wait ?? 0)
            ? true
            : undefined;
        },
        120_000,
        25,
      );

      // Observe the run with the same agent.wait call the Browser Talk consult
      // listener uses, then interrupt the pending observation.
      const drained = gateway
        .call("agent.wait", { runId: turn.runId, timeoutMs: 120_000 }, { timeoutMs: 130_000 })
        .then(
          (result) => ({ ok: true, result }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
      const drainedSettled = drained.then(() => true);
      let drainedOutcome: "pending" | "settled" = "pending";
      drained.then(() => {
        drainedOutcome = "settled";
      });

      // The observation must be admitted and genuinely pending before it is
      // interrupted. A rejected wait (unknown run, session-scoped rejection)
      // settles immediately with an error instead of staying open, so proving
      // this pending state is what separates "the reset retired a live
      // observation" from "the wait had already failed". `status` on the active
      // row is the Gateway's own projection of the run the wait is observing.
      await waitForQaTransportCondition(
        async () => {
          if (await drainedSettled) {
            throw new Error("agent.wait settled before the restart: it was never pending");
          }
          const list = (await gateway.call("sessions.list", {
            agentId: "qa",
            limit: 100,
          })) as ControlUiSessionListResult;
          const row = list.sessions.find((session) => session.key === sessionKey);
          return row?.hasActiveRun && row.status === "running" ? true : undefined;
        },
        120_000,
        25,
        () => `agent.wait did not stay pending on run ${turn.runId}; observed=${drainedOutcome}`,
      );

      // Interrupt the pending observation. A plain safe restart would defer while
      // active work remains, letting the hold release and the run finish first;
      // skipDeferral bypasses that gate so the lifecycle reset actually retires
      // the in-flight wait (src/infra/restart-coordinator.ts:112-119).
      console.log("Triggering a non-deferring gateway restart to interrupt a pending wait...");
      await gateway.call("gateway.restart.request", {
        reason: "e2e-consult-draining-test",
        safe: true,
        skipDeferral: true,
      });

      // The wait owner resolves an interrupted observation as a terminal timeout
      // tagged gateway_draining (src/gateway/agent-turn/agent-job.ts:710). This is
      // the wire contract ui/src/pages/chat/talk/shared.ts keys on to reject the
      // consult instead of falling through to the no-text completion fallback.
      const observation = await drained;
      if (!observation.ok) {
        throw new Error(`agent.wait rejected during draining: ${String(observation.error)}`);
      }
      const { status, timeoutPhase } = observation.result as {
        status?: string;
        timeoutPhase?: string;
      };
      expect({ status, timeoutPhase }).toEqual({
        status: "timeout",
        timeoutPhase: "gateway_draining",
      });
    } finally {
      await owner.stop();
      await mock.stop();
      await bus.stop();
    }
  }, 180_000);
});
