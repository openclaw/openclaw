import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createTestReplyOperation } from "../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as transcript from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import * as gatewayContinuation from "../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { withExecRequestTurn } from "../infra/exec-request-context.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { preparePluginToolGatewayCapability } from "./plugin-tool-gateway.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as gatewayTransport from "./tools/in-process-gateway.js";

// Exercise the real detached handoff and Gateway RPC. Only resume transport is
// fixed I/O; fallback notices are verified through the persisted transcript.
afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it.for([
  "active",
  "active-notice",
  "retired-resume",
  "retired-notice",
  "formatter-error",
  "formatter-error-notice",
] as const)("delivers a plugin handoff result with lifecycle %s", async (lifecycle, { signal }) => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true, env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const sessionKey = "agent:main:plugin-handoff";
      const sessionId = "plugin-handoff";
      const runId = "plugin-handoff-run";
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                scopes: ["operator.write"],
                agents: ["main"],
                sessions: { others: "none" },
              },
            },
          },
        },
        plugins: { enabled: false },
        skills: { load: { watch: false } },
      };
      setRuntimeConfigSnapshot(config);
      await state.writeConfig(config);
      const client = createOperatorClient({
        profileName: "plugin-handoff-owner",
        scopes: ["operator.write"],
      });
      client.internal = {
        authenticatedOperator: true,
        operatorRoleActor: {
          kind: "operator",
          profileId: client.authenticatedUserProfile!.profileId,
        },
        operatorAccessAuthority: {
          assertCurrent() {},
          signal: new AbortController().signal,
          gatewayAccessGrant: null,
        },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        },
      );
      const operation = createTestReplyOperation({
        sessionKey,
        sessionId,
        target: captureSessionTarget({
          storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          sessionKey,
          incarnation: sessionId,
        }),
      });
      operation.setPhase("running");
      operation.attachBackend({ kind: "embedded", runId, cancel() {} });
      const cleanup = createDeferredCore();
      const entered = createDeferredCore();
      const rpcDone = createDeferredCore();
      const resumed = createDeferredCore<string>();
      const noticed = createDeferredCore();
      const released = createDeferredCore();
      let capturedContinuation = false;
      const capture = gatewayContinuation.captureOperatorToolGatewayContinuationContext;
      vi.spyOn(
        gatewayContinuation,
        "captureOperatorToolGatewayContinuationContext",
      ).mockImplementation((...args) =>
        capture(...args)?.then((captured) => {
          capturedContinuation = true;
          const release = captured.release;
          captured.release = () => {
            release();
            released.resolve(undefined);
          };
          return captured;
        }),
      );
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({ id: "fixture", enabled: true });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config });
      const plugin = getPluginInstance(record)!;
      onTestFinished(async () => {
        await plugin.dispose();
      });
      const excludedValue = "excluded-gateway-payload-value";
      const formatterFails =
        lifecycle === "formatter-error" || lifecycle === "formatter-error-notice";
      const noticeExpected =
        lifecycle === "active-notice" ||
        lifecycle === "retired-notice" ||
        lifecycle === "formatter-error-notice";
      const dispatch = gatewayTransport.callAgentToolGatewayRequest;
      vi.spyOn(gatewayTransport, "callAgentToolGatewayRequest").mockImplementation(
        async <T>(request: Parameters<typeof dispatch>[0]) => {
          const result = await dispatch<T>(request);
          if (lifecycle === "retired-resume" || lifecycle === "retired-notice") {
            await plugin.dispose();
          }
          return result;
        },
      );
      const formatter = vi.fn((payload: Record<string, unknown>) => {
        expect(payload).toMatchObject({ status: "prepared" });
        if (formatterFails) {
          throw new Error(`Fixture formatter failed: ${excludedValue}`);
        }
        return "formatted by the active plugin";
      });
      api.registerGatewayMethod(
        "fixture.prepare",
        async ({ respond }) => {
          entered.resolve(undefined);
          await rpcDone.promise;
          respond(true, { status: "prepared", excludedField: excludedValue });
        },
        { scope: "operator.write" },
      );
      const context = createContext([], () => config);
      const methods = createGatewayMethodRegistry(
        builder.registry.gatewayMethodDescriptors,
        builder.registry,
      );
      context.getGatewayMethodRegistry = () => methods;
      const appendNotice = transcript.appendAssistantMessageToSessionTranscript;
      vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript").mockImplementation(
        async (params) => {
          try {
            return await appendNotice(params);
          } finally {
            noticed.resolve(undefined);
          }
        },
      );
      vi.spyOn(events, "enqueueSessionEventForHost").mockImplementation((text) => {
        resumed.resolve(text);
        return {
          id: "plugin-handoff-result",
          cancel: () => false,
          accepted: Promise.resolve(
            noticeExpected
              ? { ok: false as const, error: `Resume transport unavailable: ${excludedValue}` }
              : { ok: true as const },
          ),
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        };
      });
      try {
        await withPluginRuntimeGatewayRequestScope(
          {
            client,
            context,
            pluginRegistry: builder.registry,
            resolveGatewayContext: () => context,
            isWebchatConnect: () => false,
          },
          () =>
            gatewayContinuation.withOperatorToolGatewayAuthority(
              { scopes: ["operator.write"] },
              () =>
                withExecRequestTurn(
                  { identity: { agentId: "main", sessionKey, sessionId, runId } },
                  () =>
                    withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, async () => {
                      const gateway = preparePluginToolGatewayCapability(
                        {
                          sessionId,
                          runId,
                          onYield() {
                            operation.completeWithAfterClearBarrier(cleanup.promise);
                          },
                        },
                        { agentId: "main", sessionKey },
                      )(() => {}, plugin.lifecycle.signal, ["fixture.prepare"], "fixture");
                      const acknowledgment = await gateway.handoff({
                        name: "Fixture preparation",
                        method: "fixture.prepare",
                        params: { sessionKey },
                        formatResult: formatter,
                      });
                      expect(acknowledgment.details).toMatchObject({
                        status: "started",
                        yielded: true,
                      });
                      cleanup.resolve(undefined);
                      await withinTest(
                        awaitGateBeforeSettlement(
                          entered.promise,
                          Promise.race([
                            noticed.promise,
                            resumed.promise.then((text) => {
                              throw new Error(`${text} ${JSON.stringify(formatter.mock.calls)}`);
                            }),
                          ]),
                          "Handoff failed before Gateway RPC admission",
                        ),
                        signal,
                      );
                      rpcDone.resolve(undefined);
                      const text = await withinTest(
                        awaitGateBeforeSettlement(
                          resumed.promise,
                          released.promise,
                          "Handoff settled without a result",
                        ),
                        signal,
                      );
                      if (lifecycle === "active" || lifecycle === "active-notice") {
                        expect(text).toContain("formatted by the active plugin");
                        expect(formatter).toHaveBeenCalledOnce();
                      } else if (formatterFails) {
                        expect(text).toContain("The handed-off operation returned a result.");
                        expect(text).not.toContain("ended with an error");
                        expect(text).not.toContain("retry");
                        expect(formatter).toHaveBeenCalledOnce();
                      } else {
                        expect(text).toContain("The handed-off operation returned a result.");
                        expect(formatter).not.toHaveBeenCalled();
                      }
                      expect(text).not.toContain(excludedValue);
                      expect(text).not.toContain("excludedField");
                      expect(text).toContain("Do not repeat a completed operation.");
                      if (noticeExpected) {
                        await withinTest(
                          awaitGateBeforeSettlement(
                            noticed.promise,
                            released.promise,
                            "Handoff settled without a notice",
                          ),
                          signal,
                        );
                        const messages = await readSessionMessagesAsync(
                          {
                            agentId: "main",
                            sessionKey,
                            sessionId,
                            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
                          },
                          { mode: "full", reason: "retired plugin handoff notice" },
                        );
                        const last = expectDefined(messages.at(-1), "persisted handoff notice");
                        const noticeText = JSON.stringify(last);
                        expect(noticeText).not.toContain("Resume transport unavailable");
                        expect(noticeText).toContain(
                          lifecycle === "active-notice"
                            ? "formatted by the active plugin"
                            : "The handed-off operation returned a result.",
                        );
                        expect(noticeText).toContain("do not repeat");
                        expect(noticeText).not.toContain("retry");
                        expect(noticeText).not.toContain(excludedValue);
                        expect(noticeText).not.toContain("excludedField");
                        if (formatterFails || lifecycle === "active-notice") {
                          expect(formatter).toHaveBeenCalledOnce();
                        } else {
                          expect(formatter).not.toHaveBeenCalled();
                        }
                      }
                    }),
                ),
            ),
        );
      } finally {
        cleanup.resolve(undefined);
        rpcDone.resolve(undefined);
        operation.complete();
        if (capturedContinuation) {
          await withinTest(released.promise, signal);
        }
      }
    },
  );
});
