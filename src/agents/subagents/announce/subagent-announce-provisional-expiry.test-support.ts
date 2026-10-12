// A wait expiry observes the waiter, not a failure of its child. These cases
// exercise the real DM fallback when the requester supplies no delivered update.
import { expect, it, vi } from "vitest";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import type { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import {
  expectRecordFields,
  mockCallArg,
  taskCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  createSendMessageMock,
  type deliverSubagentAnnouncement,
} from "./subagent-announce-delivery.test-support.js";

type AnnouncementInput = Parameters<typeof deliverSubagentAnnouncement>[0];

export function registerProvisionalExpiryDeliveryTests(params: {
  createGatewayMock: (
    response?: Record<string, unknown> | Error,
    onCall?: () => void,
  ) => typeof runtimeCallGateway;
  deliverDiscordDirectMessageCompletion: (
    fixture: Partial<AnnouncementInput> & {
      callGateway: typeof runtimeCallGateway;
      sendMessage?: typeof runtimeSendMessage;
    },
  ) => ReturnType<typeof deliverSubagentAnnouncement>;
}) {
  const { createGatewayMock, deliverDiscordDirectMessageCompletion } = params;
  // Wait expiry observes only the waiter, not failure of its child. Exercise
  // the actual DM fallback after the requester supplies no delivered update.
  it.each([
    { response: "silent", disposition: "still-running", failedChild: false },
    { response: "synthesis error", disposition: "still-running", failedChild: false },
    { response: "silent", disposition: "exited", failedChild: true },
    { response: "synthesis error", disposition: "exited", failedChild: true },
    { response: "silent", disposition: "killed", failedChild: true },
    { response: "synthesis error", disposition: "killed", failedChild: true },
  ] as const)(
    "distinguishes provisional expiry from terminal failure for $response / $disposition",
    async ({ response, disposition, failedChild }) => {
      const requesterError = "requester synthesis unavailable";
      const callGateway = createGatewayMock({ result: { payloads: [{ text: "NO_REPLY" }] } });
      if (response === "synthesis error") {
        vi.mocked(callGateway).mockRejectedValue(new Error(requesterError));
      }
      const sendMessage = createSendMessageMock();
      const childSessionKey = "agent:worker:subagent:provisional-expiry";
      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
        internalEvents: taskCompletionEvents({
          childSessionKey,
          childSessionId: "provisional-expiry-session",
          status: "timeout",
          statusLabel: failedChild ? "timed out" : "wait expired; child stop NOT observed",
          disposition,
          result: failedChild
            ? "(no output)"
            : "(no output observed before this wait expired; the child may still be working — re-check before acting on this)",
          noVisibleResult: true,
        }),
      });

      expect(callGateway).toHaveBeenCalledOnce();
      if (failedChild) {
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(mockCallArg(sendMessage, 0, 0).content).toBe(
          "A delegated task failed before it could report a result. Please retry the task.",
        );
        expectRecordFields(result, { delivered: true, path: "direct" });
      } else {
        expect(sendMessage).not.toHaveBeenCalled();
        // An unobserved stop is neither a failed child nor a delivery receipt.
        expectRecordFields(result, { delivered: false, path: "direct" });
        expect(result.requesterVisibleFinalDelivered).toBeUndefined();
        if (response === "synthesis error") {
          expect(result.disposition).toBe("retryable");
          expect(result.error).toContain(requesterError);
        } else {
          // Instructed silence is a settled non-delivery, not a failure to
          // retry: a retryable result here re-announces every few seconds for
          // as long as the child keeps working.
          expect(result.disposition).toBe("intentional_non_delivery");
          expect(result.terminal).toBe(true);
          expect(result.error).toBeUndefined();
        }
      }
    },
  );
}
