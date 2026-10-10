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
 * observation rather than racing a settled turn.
 *
 * Scope boundary: this proves the Gateway wait response only. It does not drive
 * a Browser Talk session, so it does not yet prove the correlated timeout is
 * submitted through the voice transport; that boundary has no harness here.
 */

import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.js";

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

      // Synchronize on the hold before interrupting: the run must be running with
      // its `wait` tool call still in flight. A run that has already settled would
      // answer `ok` and prove nothing about the draining classification.
      await transport.waitForCondition(
        async () => {
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          if (entry?.status !== "running") {
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

      // The hold keeps the run pending, so an admitted wait stays open until the
      // reset retires it; an unadmitted one resolves with a run-not-found error,
      // which the assertion below reports rather than hiding.

      console.log("Triggering gateway restart to interrupt a pending wait...");
      await gateway.call("gateway.restart.request", {
        reason: "e2e-consult-draining-test",
        safe: true,
      });

      // The wait owner resolves an interrupted observation as a terminal timeout
      // tagged gateway_draining (src/gateway/agent-turn/agent-job.ts:710). This is
      // the wire contract ui/src/pages/chat/talk/shared.ts keys on to reject the
      // consult instead of falling through to the no-text completion fallback.
      const observation = await drained;
      if (!observation.ok) {
        throw new Error(`agent.wait rejected during draining: ${String(observation.error)}`);
      }
      const result = observation.result as { status?: string; timeoutPhase?: string };
      expect({ status: result.status, timeoutPhase: result.timeoutPhase }).toEqual({
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
