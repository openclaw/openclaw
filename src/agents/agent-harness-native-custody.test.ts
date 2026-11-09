import { afterEach, assert, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { projectGatewaySessionRunState } from "../gateway/session-utils-display.js";
import { buildSessionListRowMetadataContext } from "../gateway/session-utils-projection.js";
import { onAgentEventForRun, resetAgentEventsForTest } from "../infra/agent-events.js";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessCompletionEventSink,
  runWithAgentHarnessCompletionCustody,
  type AgentHarnessCompletionCustody,
} from "./agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "./agent-harness-completion-scope.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  clearRuntimeConfigSnapshot();
});

it.each(["source-replaced", "released", "gateway-closed", "settled"] as const)(
  "retains the admitted source through yield but fences %s events",
  (ending) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const context = createContext();
      const resolver = () => context;
      context.resolveGatewayContext = resolver;
      const entry = { sessionId: "native-requester", updatedAt: Date.now() };
      await replaceSessionEntry({ agentId: "main", sessionKey: "agent:main:main" }, entry);
      const scope = createAgentHarnessCompletionScope({
        requesterSessionKey: "agent:main:main",
        gatewayContextResolver: resolver,
      });
      const runId = "native:child";
      const received = vi.fn();
      const stop = onAgentEventForRun(runId, received);
      const root = tryBeginGatewayRootWorkAdmission("test:native-event")!;
      let callerCurrent = true;
      let sourceCurrent = true;
      let custody: AgentHarnessCompletionCustody | undefined;
      try {
        custody = await root.run(() =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: scope.requesterSessionKey,
              operationalRunInstance:
                createTestAdmittedRunContext("parent-run").operationalRunInstance,
              receiptAuthority: () => callerCurrent,
              gatewayContextResolver: resolver,
            },
            () => captureAgentHarnessCompletionCustody(scope),
          ),
        );
        assert.ok(custody, "Expected admitted native completion custody");
        const emit = createAgentHarnessCompletionEventSink({
          scope,
          completionCustody: custody,
          runId,
          isSourceCurrent: () => sourceCurrent,
        });
        root.release();
        callerCurrent = false;
        markGatewayRestartDraining();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        emit({ stream: "assistant", data: { text: "Native result" } });
        expect(received).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ runId, agentId: "main", stream: "assistant" }),
        );
        const activity = (sessionId = entry.sessionId) =>
          projectGatewaySessionRunState({
            key: scope.requesterSessionKey,
            entry: { ...entry, sessionId },
            now: Date.now(),
            rowContext: buildSessionListRowMetadataContext({ now: Date.now() }),
          }).fields.hasActiveSubagentRun === true;
        emit({ stream: "execution", data: { state: "running", sourceId: "native" } });
        expect(activity()).toBe(true);
        expect(activity("replacement-requester")).toBe(false);
        // The child's observation must not invent an abortable foreground run.
        expect(buildProjectedAgentRunIndex().sessionKeys.size).toBe(0);
        emit({ stream: "execution", data: { state: "unknown", sourceId: "native" } });
        expect(activity()).toBe(false);
        emit({ stream: "execution", data: { state: "waiting", sourceId: "native" } });
        expect(activity()).toBe(true);
        if (ending === "source-replaced") {
          sourceCurrent = false;
        } else if (ending === "released") {
          custody.release();
        } else if (ending === "gateway-closed") {
          getGatewayContextLifetime(resolver).abort();
        } else {
          custody.settleExecution();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          expect(runWithAgentHarnessCompletionCustody(custody, scope, () => true)).toBe(true);
        }
        expect(() => emit({ stream: "assistant", data: { text: "Late result" } })).toThrow();
        expect(activity()).toBe(false);
        expect(received).toHaveBeenCalledTimes(4);
      } finally {
        custody?.release();
        root.release();
        stop();
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    }),
);
