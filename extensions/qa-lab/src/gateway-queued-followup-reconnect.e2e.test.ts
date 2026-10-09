import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { readRawQaSessionStore } from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const FIRST_REPLY_MARKER = "QA-QUEUED-FOLLOWUP-RECONNECT-FIRST-OK";
const TOOL_AUTHORITY_SNAPSHOT_ERROR = "Reply operation has no active tool authority snapshot";

// Regression for https://github.com/openclaw/openclaw/issues/139847: an
// operator reply sent from the interface must reuse the tool authority of the
// task's originating session, including after a page reload / WebSocket
// reconnect resumes an already-running task, not only when the same
// connection sends a second message. The existing coverage in
// followup-turn-admission.queued-handoff.test.ts and
// gateway-queued-followup-send.e2e.test.ts proves admission binds a snapshot,
// but always issues both `chat.send` calls over one persistent connection.
// This test opens a second, independent Gateway WebSocket connection for the
// queued reply -- the same shape a Control UI tab reload or a dropped/restored
// WebSocket produces -- to prove the fix does not depend on connection
// continuity, only on the session key.
//
// Scope note: this runs the embedded runtime (mock-openai), where pre-fix the
// queued turn does not throw -- it silently falls back to unscoped direct
// attempt authority instead of the session's bound snapshot
// (tool-authority.runtime.ts). That silent substitution is not black-box
// observable through delivered replies or gateway logs, so this test proves
// full-stack delivery survives a reconnect, not the authority-source
// difference. The authoritative RED/GREEN proof for the exact throw guarded
// by bindToolAuthorityRoute is followup-turn-admission.queued-handoff.test.ts.
describe.skipIf(process.platform === "win32")(
  "queued follow-up admitted from a reconnected Gateway connection",
  () => {
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
        throw new AggregateError(errors, "queued follow-up reconnect test cleanup failed");
      }
    });

    it("lets a reply sent from a fresh connection reuse the active session's authority", async () => {
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
        // Debug logging makes the queued-admission overlap ("sessionState=processing")
        // observable in the child gateway log for this regression.
        runtimeEnvPatch: { OPENCLAW_LOG_LEVEL: "debug" },
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
          // The reported loss is on the queued-followup path, so do not steer.
          messages: { ...cfg.messages, queue: { ...cfg.messages?.queue, mode: "followup" } },
        }),
      });
      const conversation = { id: "queued-followup-reconnect", kind: "direct" as const };
      const sessionKey = buildAgentSessionKey({
        agentId: "qa",
        channel: "qa-channel",
        accountId: transport.accountId,
        peer: { kind: "direct", id: `dm:${conversation.id}` },
        dmScope: gateway.cfg.session?.dmScope,
        identityLinks: gateway.cfg.session?.identityLinks,
      });
      const delivery = transport.buildAgentDelivery({ target: `dm:${conversation.id}` });
      // A fresh RPC connection to the same running Gateway -- what a reloaded
      // Control UI tab or a WebSocket reconnect produces after a drop. The
      // original connection is never reused; only the session key ties the
      // two requests together.
      const reconnected = await startQaGatewayRpcClient({
        wsUrl: gateway.wsUrl,
        token: gateway.token,
        logs: gateway.logs,
      });
      cleanups.push(() => reconnected.stop());
      try {
        await transport.waitReady({ gateway });
        const sinceIndex = state.getSnapshot().messages.length;
        // First message on the original connection. The mock holds this turn's
        // response so the reconnected client's message is admitted as a queued
        // follow-up while this reply run is still active.
        const first = (await gateway.call(
          "chat.send",
          {
            idempotencyKey: randomUUID(),
            sessionKey,
            message: `queued followup stall gateway qa check. Reply exactly: ${FIRST_REPLY_MARKER}`,
            deliver: true,
            originatingChannel: delivery.replyChannel,
            originatingTo: delivery.replyTo,
          },
          { timeoutMs: 30_000 },
        )) as { runId?: string };
        expect(first.runId).toBeTruthy();
        // Wait until the first turn's reply run has actually started (INFO log),
        // not merely enqueued, so the reconnected client's message is a genuine
        // mid-run arrival, not a race with admission of the first message.
        await transport.waitForCondition(
          () => (gateway.logs().includes("embedded run start: runId=") ? true : undefined),
          60_000,
          25,
        );
        expect(
          state
            .getSnapshot()
            .messages.some(
              (message) =>
                message.direction === "outbound" && message.text.includes(FIRST_REPLY_MARKER),
            ),
        ).toBe(false);
        // Second message on the reconnected connection, same session key, while
        // the first run is still active on the Gateway.
        const SECOND_MESSAGE_TEXT = "repeated request queued reply gateway qa check";
        const second = (await reconnected.request(
          "chat.send",
          {
            idempotencyKey: randomUUID(),
            sessionKey,
            message: SECOND_MESSAGE_TEXT,
            deliver: true,
            originatingChannel: delivery.replyChannel,
            originatingTo: delivery.replyTo,
          },
          { timeoutMs: 30_000 },
        )) as { runId?: string };
        // The reconnected client's own runId proves admission accepted the
        // queued turn without throwing "no active tool authority snapshot" --
        // pre-fix, this call would still resolve (the throw happens later,
        // inside the deferred queued run), so the real proof is the reply
        // below actually arriving rather than being silently dropped.
        expect(second.runId).toBeTruthy();
        expect(second.runId).not.toBe(first.runId);

        const firstReply = await transport.waitForOutbound({
          conversation,
          sinceIndex,
          textIncludes: FIRST_REPLY_MARKER,
          timeoutMs: 120_000,
        });
        // Pre-fix, the reconnected client's queued turn threw at route binding
        // on route-binding backends and the message was dropped; on embedded
        // runs it silently fell back to unsteerable direct authority. Either
        // way this reply never arrived.
        const queuedReply = await transport.waitForOutbound({
          conversation,
          sinceIndex,
          textIncludes: QA_REPEATED_REQUEST_QUEUED_REPLY_MARKER,
          timeoutMs: 120_000,
        });
        expect(queuedReply.accountId).toBe(transport.accountId);

        // Ordering: the queued turn ran and replied after the first turn finished.
        const outbound = state
          .getSnapshot()
          .messages.slice(sinceIndex)
          .filter((message) => message.direction === "outbound");
        expect(outbound.findIndex((message) => message.id === firstReply.id)).toBeLessThan(
          outbound.findIndex((message) => message.id === queuedReply.id),
        );
        expect(gateway.logs()).not.toContain(TOOL_AUTHORITY_SNAPSHOT_ERROR);
        await transport.waitForCondition(
          async () =>
            (await readRawQaSessionStore({ gateway }))[sessionKey]?.status === "done"
              ? true
              : undefined,
          30_000,
          25,
        );
      } catch (error) {
        const sessions = await Promise.allSettled([readRawQaSessionStore({ gateway })]);
        throw new Error(
          `${String(error)}\nsessions=${JSON.stringify(sessions)}\nbus=${JSON.stringify(state.getSnapshot())}\ngateway=${gateway.logs()}`,
          { cause: error },
        );
      }
    }, 600_000);
  },
);
