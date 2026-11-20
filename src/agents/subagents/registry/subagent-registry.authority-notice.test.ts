import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { captureAgentTurnPrincipal } from "../../../gateway/agent-turn/principal.js";
import {
  captureGatewayDeviceRevocation,
  readGatewayDeviceRevocationGuard,
} from "../../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { captureGatewayOperatorContinuation } from "../../../gateway/operator-run-recovery.js";
import { withRecovery } from "../../../gateway/operator-run-recovery.test-support.js";
import {
  SharedGatewaySessionGenerationState,
  enforceSharedGatewaySessionGenerationForConfigWrite,
} from "../../../gateway/server-shared-auth-generation.js";
import {
  announceTesting,
  setSubagentAnnounceDeliveryDepsForTest,
} from "../announce/subagent-announce-overrides.test-support.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  admitCompletionFixtureDatabase,
  armRequesterWake,
  records,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";

// Gateway execution is the external boundary; admission, classification, registry and notice writes stay real.
afterEach(() => {
  announceTesting.setDepsForTest();
  setSubagentAnnounceDeliveryDepsForTest();
  vi.restoreAllMocks();
  subagentRuns.clear();
});

it.each(["revoked continuation", "source owner changed"] as const)(
  "preserves captured results after policy invalidation through %s",
  async (route) =>
    withRecovery(
      async (fixture) => {
        await admitCompletionFixtureDatabase();
        const generation = new SharedGatewaySessionGenerationState({
          current: "before",
          required: null,
        });
        const caller = captureGatewayDeviceRevocation(
          fixture.context,
          { deviceId: "recovery-device", role: "operator" },
          () => true,
          undefined,
          {
            isCurrent: () => true,
            subscribe: (revoked) => generation.onInvalidated("before", revoked),
          },
        );
        const origin = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: captureAgentTurnPrincipal(fixture.client),
            context: fixture.context,
            sourceAuthority: null,
            hasCurrentClientAuthority: caller.isCurrent,
          }),
          "origin",
        );
        fixture.client.internal!.operatorRunAuthority = origin.authority;
        const continuation = expectDefined(
          await captureGatewayOperatorContinuation({
            client: fixture.client,
            context: fixture.context,
          }),
          "continuation",
        );
        const releaseContinuation = expectDefined(continuation.authority.retain, "retain")();
        continuation.release();
        origin.release();
        caller.release();
        try {
          const { subagent } = records();
          Object.assign(subagent, {
            requesterSessionKey: fixture.target.sessionKey,
            requesterStorePath: fixture.target.storePath,
            requesterOrigin: { channel: "webchat" },
            endedReason: "subagent-complete",
            cleanup: "keep",
            delivery: { status: "pending", generation: 1 },
          });
          subagent.completion!.resultText = "CAPTURED ANSWER before policy edit";
          if (route === "revoked continuation") {
            armRequesterWake({ subagent });
          }
          seedSubagentCompletionOwner({ subagent });
          enforceSharedGatewaySessionGenerationForConfigWrite({
            state: generation,
            nextConfig: {},
            resolveRuntimeSnapshotGeneration: () => "after",
            clients: [],
          });
          const reauthorize = expectDefined(continuation.authority.reauthorize, "reauthorize");
          expect(reauthorize).toThrow("Operator access was revoked; start a new user turn.");
          const model = vi.fn();
          const gateway = vi.fn(async (request: { method: string }) => {
            if (request.method === "agent") {
              reauthorize();
              model();
            }
            return { messages: [] };
          });
          announceTesting.setDepsForTest({ callGateway: gateway, getRuntimeConfig: () => ({}) });
          setSubagentAnnounceDeliveryDepsForTest({
            callGateway: gateway,
            getRuntimeConfig: () => ({}),
          });
          using driver = requesterWakeDriver([{ subagent }]);
          driver.wake.mockImplementation(
            route === "revoked continuation"
              ? maybeWakeRequesterAfterAllChildrenSettled
              : async () => false,
          );
          driver.controller.options.runSubagentAnnounceFlow = (params) =>
            runSubagentAnnounceFlow({
              ...params,
              ...(route === "source owner changed"
                ? {
                    isCompletionDeliveryAllowed: expectDefined(
                      readGatewayDeviceRevocationGuard(continuation.authority.assertCurrent),
                      "source guard",
                    ),
                  }
                : {}),
            });
          const flush = observeRootWork();
          if (route === "revoked continuation") {
            await driver.run();
          } else {
            expect(driver.controller.startSubagentAnnounceCleanupFlow(subagent)).toBe(true);
          }
          await flush();
          expect(model).not.toHaveBeenCalled();
          const stored = loadSubagentRegistryFromSqlite().get(subagent.runId);
          expect(stored?.delivery).toMatchObject({
            status: route === "revoked continuation" ? "failed" : "suspended",
            disposition: "permanent_failure",
            lastError:
              route === "revoked continuation"
                ? "Operator access was revoked; start a new user turn."
                : expect.stringContaining(
                    "subagent source lifecycle changed before completion delivery",
                  ),
          });
          expect(driver.warn).not.toHaveBeenCalled();
          const notices = (await loadTranscriptEvents(fixture.target)).filter(
            (event) => isRecord(event) && event.type === "custom_message" && event.display === true,
          );
          expect(notices).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                content: expect.stringContaining("CAPTURED ANSWER before policy edit"),
              }),
            ]),
          );
        } finally {
          releaseContinuation();
        }
      },
      { tokenlessDevice: true, parentSessionKey: null },
    ),
);
