import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
} from "../../../gateway/device-revocation.js";
import { captureGatewayOperatorContinuation } from "../../../gateway/operator-run-recovery.js";
import { withRecovery } from "../../../gateway/operator-run-recovery.test-support.js";
import { removePairedDevice } from "../../../infra/device-pairing.js";
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

it.each(["removed paired device", "closed source owner"] as const)(
  "preserves captured results and publishes a notice after %s prevents delivery",
  async (route) =>
    withRecovery(
      async (fixture, stateDir) => {
        await admitCompletionFixtureDatabase();
        const caller = captureGatewayDeviceRevocation(
          fixture.context,
          { deviceId: "recovery-device", role: "operator" },
          () => true,
        );
        fixture.client.internal!.operatorRunAuthority = fixture.sourceAuthority;
        const continuation = expectDefined(
          await captureGatewayOperatorContinuation({
            client: fixture.client,
            agentId: fixture.target.agentId,
            context: fixture.context,
          }),
          "continuation",
        );
        fixture.client.internal!.operatorRunAuthority = continuation.authority;
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
          subagent.completion!.resultText = "CAPTURED ANSWER before delivery became unavailable";
          if (route === "removed paired device") {
            armRequesterWake({ subagent });
          }
          seedSubagentCompletionOwner({ subagent });
          if (route === "removed paired device") {
            await removePairedDevice("recovery-device", stateDir);
          } else {
            closeGatewayDeviceRevocation(fixture.context);
          }
          const model = vi.fn();
          const gateway = vi.fn(async (request: { method: string }) => {
            if (request.method === "agent") {
              const started = expectDefined(
                await captureGatewayOperatorContinuation({
                  client: fixture.client,
                  agentId: fixture.target.agentId,
                  context: fixture.context,
                }),
                "next operator start",
              );
              try {
                model();
              } finally {
                started.release();
              }
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
            route === "removed paired device"
              ? maybeWakeRequesterAfterAllChildrenSettled
              : async () => false,
          );
          driver.controller.options.runSubagentAnnounceFlow = (params) =>
            runSubagentAnnounceFlow({
              ...params,
              ...(route === "closed source owner"
                ? { isCompletionDeliveryAllowed: caller.isCurrent }
                : {}),
            });
          const flush = observeRootWork();
          if (route === "removed paired device") {
            await driver.run();
          } else {
            expect(driver.controller.startSubagentAnnounceCleanupFlow(subagent)).toBe(true);
          }
          await flush();
          expect(model).not.toHaveBeenCalled();
          const stored = loadSubagentRegistryFromSqlite().get(subagent.runId);
          expect(stored?.delivery).toMatchObject({
            status: route === "removed paired device" ? "failed" : "suspended",
            disposition: "permanent_failure",
            lastError:
              route === "removed paired device"
                ? expect.stringContaining("a new user turn.")
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
                content: expect.stringContaining(
                  "CAPTURED ANSWER before delivery became unavailable",
                ),
              }),
            ]),
          );
        } finally {
          continuation.release();
          caller.release();
        }
      },
      { tokenlessDevice: true, parentSessionKey: null },
    ),
);
