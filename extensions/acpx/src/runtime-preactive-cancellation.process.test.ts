/** Real dispatcher -> manager -> ACPX -> stdio ACP peer cancellation proof. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  testing,
  tryDispatchAcpReplyHook,
} from "openclaw/plugin-sdk/acp-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { AcpxRuntime } from "./runtime.js";

const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));

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
      const runtime = new AcpxRuntime({
        cwd: state.root,
        sessionStore: createFileSessionStore({ stateDir: state.root }),
        agentRegistry: createAgentRegistry({
          overrides: { "cancel-fixture": [process.execPath, peer, peerDirectory] },
        }),
        permissionMode: "deny-all",
        timeoutMs: 5_000,
      });
      registerAcpRuntimeBackend({ id: "acpx", runtime });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      const sessionKey = `agent:main:acp:preactive-${phase}`;
      const target = { cfg, sessionKey, agentId: "main" };
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
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
      let cancel: Promise<void> | undefined;
      try {
        await manager.initializeSession({ ...target, agent: "cancel-fixture", mode: "persistent" });
        // Retain the real ACP record but make runTurn reacquire its provider handle.
        await manager.closeSession({ ...target, reason: "proof-reconnect" });
        if (phase === "queued") {
          const getStatus = runtime.getStatus.bind(runtime);
          runtime.getStatus = async (input) => {
            const value = await getStatus(input);
            runtime.getStatus = getStatus;
            entered.resolve();
            await release.promise;
            return value;
          };
          actor = manager.getSessionStatus(target);
          await entered.promise;
        } else {
          const ensure = runtime.ensureSession.bind(runtime);
          runtime.ensureSession = async (input) => {
            const handle = await ensure(input);
            runtime.ensureSession = ensure;
            entered.resolve();
            await release.promise;
            return handle;
          };
        }
        dispatch = tryDispatchAcpReplyHook(
          {
            ctx: {
              Body: "cancel before submission",
              BodyForAgent: "cancel before submission",
              BodyForCommands: "cancel before submission",
              RawBody: "cancel before submission",
              From: "operator",
              To: "main",
              SessionKey: sessionKey,
              AgentId: "main",
              Provider: "webchat",
              Surface: "webchat",
              ChatType: "direct",
              CommandAuthorized: true,
              MessageSid: `cancel-${phase}`,
            },
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
        if (phase === "queued") {
          await Promise.race([
            admissionReady.promise,
            dispatch.then(() => {
              throw new Error("dispatch ended before admission");
            }),
          ]);
          await vi.waitFor(() =>
            expect(manager.getObservabilitySnapshot().turns.queueDepth).toBe(2),
          );
        } else {
          await Promise.race([
            entered.promise,
            dispatch.then(() => {
              throw new Error("dispatch ended before setup");
            }),
          ]);
        }
        cancel = manager.cancelSession({ ...target, reason: "preactive-process-proof" });
        void cancel.catch(() => {});
        release.resolve();
        await actor;
        const [result] = await Promise.all([dispatch, cancel]);
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
        release.resolve();
        await Promise.allSettled([actor, dispatch, cancel]);
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
