import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { steerSessionControllerOperation } from "../../sessions/session-controller.steer.js";
import { testing as replyRunTesting } from "../../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type { EmbeddedAgentQueueHandle } from "./runs.js";
import {
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing,
} from "./runs.test-support.js";

const sessionId = "session";
const accept = () => true;
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  replyRunTesting.resetSessionControllerForTest();
  vi.restoreAllMocks();
});

describe("controller-owned FIFO target handoff", () => {
  it.each(["stopped", "replaced", "caller-revoked", "receiver-revoked"] as const)(
    "preserves receiver settlement versus authority refusal: %s",
    async (change) => {
      const entered = createDeferredCore(),
        release = createDeferredCore();
      const sessionKey = "agent:main:handoff-classification";
      let receiverCurrent = true,
        callerCurrent = true,
        stopped = false;
      const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(async () => {});
      const handle = createEmbeddedRunHandle({ runId: "receiver", isStopped: () => stopped });
      handle.messageInjectionV2 = {
        version: 2,
        isAvailable: () => !stopped,
        queueMessage: async (text, options, assertCurrent) => {
          assertCurrent();
          await queueMessage(text, options);
        },
      };
      const assertReceiverCurrent = () => {
        if (!receiverCurrent) {
          throw new Error("receiver authority closed");
        }
      };
      const operation = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          embeddedRunToolAuthorityBinding: () => ({
            source: "reply",
            project: () => "authority",
            projectAsync: async () => "authority",
            acceptsRequesterOrigin: accept,
            assertRegistrationActive: assertReceiverCurrent,
            assertActive: assertReceiverCurrent,
          }),
        },
        () => setActiveEmbeddedRun(sessionId, handle, sessionKey),
      );
      const first = steerSessionControllerOperation({
        operation,
        text: "first",
        options: {
          assertCurrent() {},
          toolAuthorityPreparation: {
            authorityKind: "source-bound",
            assertCurrent() {},
            compatAssertCurrent() {},
            async prepareCurrent() {},
            async prepareMessage() {
              entered.resolve();
              await release.promise;
              return "first";
            },
          },
        },
      });
      // Join both outcomes even when replacement closes the predecessor's admission.
      const firstSettled = first.then(
        () => undefined,
        () => undefined,
      );
      await entered.promise;
      const second = steerSessionControllerOperation({
        operation,
        text: "second",
        options: {
          assertCurrent() {
            if (!callerCurrent) {
              throw new Error("caller authority closed");
            }
          },
        },
      });
      const secondSettled = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (change === "replaced") {
        setActiveEmbeddedRun(
          sessionId,
          createEmbeddedRunHandle({ runId: "replacement" }),
          sessionKey,
        );
      } else if (change !== "receiver-revoked") {
        stopped = true;
      }
      receiverCurrent = false;
      if (change === "caller-revoked") {
        callerCurrent = false;
      }
      release.resolve();
      await firstSettled;
      const outcome = await secondSettled;
      if (change === "caller-revoked" || change === "receiver-revoked") {
        expect(outcome).toHaveProperty("error");
      } else {
        expect(outcome).toMatchObject({ value: { status: "rejected" } });
      }
      expect(queueMessage).not.toHaveBeenCalled();
    },
  );
});
