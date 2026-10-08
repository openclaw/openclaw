import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { onAgentEventForRun, resetAgentEventsForTest } from "../infra/agent-events.js";
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
});

describe("native event custody", () => {
  it.each(["source-replaced", "released", "gateway-closed", "settled"] as const)(
    "retains the admitted source through yield but fences %s events",
    async (ending) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
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
          await root.run(() =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: scope.requesterSessionKey,
                operationalRunInstance:
                  createTestAdmittedRunContext("parent-run").operationalRunInstance,
                receiptAuthority: () => callerCurrent,
                gatewayContextResolver: resolver,
              },
              async () => {
                custody = await captureAgentHarnessCompletionCustody(scope);
              },
            ),
          );
          if (!custody) {
            throw new Error("Expected admitted native completion custody");
          }
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
          expect(received).toHaveBeenCalledOnce();
        } finally {
          custody?.release();
          root.release();
          stop();
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
    },
  );
});
