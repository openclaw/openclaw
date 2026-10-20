/** Real `/acp cancel` -> controller Stop -> dispatcher -> manager -> ACPX -> stdio ACP peer proof. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  testing,
  tryDispatchAcpReplyHook,
} from "openclaw/plugin-sdk/acp-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher, getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { createTestGate, ownerRuntimeOptions } from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";

it.each(["queued", "setup"] as const)(
  "cancels real %s ACP dispatch without a provider prompt or error final",
  async (phase) => {
    await withOpenClawTestState({ label: "acp-preactive-process" }, async (state) => {
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {} } },
        acp: { enabled: true, backend: "acpx", dispatch: { enabled: true } },
      };
      await state.writeConfig(cfg);
      const peerDirectory = path.join(state.root, "peer");
      await fs.mkdir(peerDirectory);
      const runtime = new AcpxRuntime(ownerRuntimeOptions(state.root, { agent: "cancel-fixture" }));
      registerAcpRuntimeBackend({ id: "acpx", runtime });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      const sessionKey = `agent:main:acp:preactive-${phase}`;
      const target = { cfg, sessionKey, agentId: "main" };
      const gate = createTestGate();
      const admissionReady = createDeferred<void>();
      const delivered: Array<{ text?: string; isError?: boolean }> = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload);
        },
      });
      const reasons: unknown[] = [];
      let prompts = 0;
      const startTurn = runtime.startTurn.bind(runtime);
      runtime.startTurn = (input) => {
        prompts += 1;
        return startTurn(input);
      };
      let actor: Promise<unknown> | undefined;
      let dispatch: ReturnType<typeof tryDispatchAcpReplyHook> | undefined;
      let cancel: ReturnType<typeof getReplyFromConfig> | undefined;
      const inbound = (text: string, messageSid: string) => ({
        Body: text,
        BodyForAgent: text,
        BodyForCommands: text,
        RawBody: text,
        From: "operator",
        To: "main",
        SessionKey: sessionKey,
        AgentId: "main",
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: messageSid,
      });
      try {
        await manager.initializeSession({ ...target, agent: "cancel-fixture", mode: "persistent" });
        // Retain the real ACP record but make runTurn reacquire its provider handle.
        await manager.closeSession({ ...target, reason: "proof-reconnect" });
        if (phase === "queued") {
          const getStatus = runtime.getStatus.bind(runtime);
          runtime.getStatus = async (input) => {
            const value = await getStatus(input);
            runtime.getStatus = getStatus;
            await gate.hold();
            return value;
          };
          actor = manager.getSessionStatus(target);
          await gate.entered;
        } else {
          const ensure = runtime.ensureSession.bind(runtime);
          runtime.ensureSession = async (input) => {
            const handle = await ensure(input);
            runtime.ensureSession = ensure;
            await gate.hold();
            return handle;
          };
        }
        dispatch = tryDispatchAcpReplyHook(
          {
            ctx: inbound("cancel before submission", `cancel-${phase}`),
            runId: `dispatch-${phase}`,
            sessionKey,
            inboundAudio: false,
            sessionTtsAuto: "off",
            suppressUserDelivery: false,
            shouldRouteToOriginating: false,
            shouldSendToolSummaries: false,
            shouldSendFullToolDetails: false,
            sendPolicy: "allow",
          },
          {
            cfg,
            dispatcher,
            onAgentRunStart: () => {
              admissionReady.resolve();
            },
            recordProcessed: (...args) => {
              reasons.push(args);
            },
            markIdle: () => {},
          },
        );
        void dispatch.catch(() => {});
        await Promise.race([
          phase === "queued" ? admissionReady.promise : gate.entered,
          dispatch.then(() => {
            throw new Error(`dispatch ended before ${phase === "queued" ? "admission" : "setup"}`);
          }),
        ]);
        if (phase === "queued") {
          await vi.waitFor(() =>
            expect(manager.getObservabilitySnapshot().turns.queueDepth).toBe(2),
          );
        }
        // `/acp cancel` is a client-session Stop; it completes while the turn is still pre-active.
        cancel = getReplyFromConfig({
          ...inbound("/acp cancel", `acp-cancel-${phase}`),
          GatewayClientScopes: ["operator.admin"],
        });
        expect(await cancel).toMatchObject({
          text: expect.stringContaining(`Cancel requested for ACP session ${sessionKey}`),
        });
        gate.release();
        await actor;
        const result = await dispatch;
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        expect(result).toMatchObject({ handled: true });
        expect(prompts).toBe(0);
        expect(delivered.filter((payload) => payload.isError)).toEqual([]);
        expect(JSON.stringify(reasons)).not.toContain("acp_error");
        const histories = await Promise.all(
          (await fs.readdir(peerDirectory)).map(
            async (name) =>
              JSON.parse(await fs.readFile(path.join(peerDirectory, name), "utf8")) as {
                history: string[];
              },
          ),
        );
        expect(histories.length).toBeGreaterThan(0);
        expect(histories.every((entry) => entry.history.length === 0)).toBe(true);
      } finally {
        await gate.settle(actor, dispatch, cancel);
        await manager.closeSession({
          ...target,
          reason: "proof-complete",
          requireAcpSession: false,
        });
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend("acpx");
      }
    });
  },
);
