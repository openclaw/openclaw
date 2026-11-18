import { expect, it, type Mock, vi } from "vitest";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { makeSubagentCompletion } from "./subagent-registry-lifecycle-completion.test-support.js";
import {
  createRunEntry as createLifecycleRunEntry,
  readLifecycleRun,
  type LifecycleTestDrivers,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  const { childSessionKey, runId } = entry;
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({ childSessionKey, childRunId: runId }),
  );
}

export function registerDeliveryMirrorCases({
  createLifecycleController,
  waitForLifecycleState,
  callGateway,
}: Omit<LifecycleTestDrivers, "createRunEntry"> & {
  callGateway: Mock<(opts: CallGatewayOptions) => Promise<unknown>>;
  blockSubagentCompletionDelivery: Mock;
  logAnnounceGiveUp: Mock;
}) {
  const failure = "completion agent did not produce a visible reply";
  it.each(["current", "message tool", "child run", "stale", "sibling"])(
    "credits only current-run requester delivery mirrors (%s)",
    async (source) => {
      const entry = createLifecycleRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        retainAttachmentsOnKeep: true,
        requesterSessionKey: "global",
        requesterAgentId: "ops",
      });
      const text = "long completion reply ".repeat(500);
      const mirrored =
        source === "sibling"
          ? { ...entry, childSessionKey: "agent:main:subagent:sibling", runId: "run-sibling" }
          : entry;
      const idempotencyKey =
        source === "child run"
          ? `${entry.runId}:message-tool:1`
          : `${buildExpectedAnnounceIdempotencyKey(mirrored)}:${source === "message tool" ? "message-tool:" : ""}internal-source-reply:0`;
      callGateway.mockImplementationOnce(async (request) => {
        expect(request.params).toMatchObject({ sessionKey: "global", agentId: "ops" });
        return {
          messages: [
            {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              content: text,
              timestamp: source === "stale" ? 1_999 : 12_345,
              idempotencyKey,
            },
          ],
        };
      });

      await createLifecycleController({
        entry,
        captureSubagentCompletionReply: vi.fn(async () => text),
        runSubagentAnnounceFlow: vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
          async ({ onDeliveryResult }) => {
            await onDeliveryResult?.({ delivered: false, path: "direct", error: failure });
            return "retryable";
          },
        ),
      }).completeSubagentRun(
        makeSubagentCompletion(entry, {
          triggerCleanup: true,
          terminalReply: { disposition: "visible", text },
        }),
      );
      const delivered = source !== "stale" && source !== "sibling";
      await waitForLifecycleState(() =>
        expect(
          delivered
            ? readLifecycleRun(entry).cleanupCompletedAt
            : readLifecycleRun(entry).delivery?.suspendedAt,
        ).toBeTypeOf("number"),
      );
      expect(callGateway.mock.calls[0]?.[0]).toMatchObject({
        method: "chat.history",
        params: { sessionKey: "global", agentId: "ops", maxChars: 128 * 1024 },
      });
      expect(readLifecycleRun(entry).delivery).toMatchObject({
        status: delivered ? "delivered" : "suspended",
        deliveredAt: delivered ? 12_345 : undefined,
        announcedAt: delivered ? 12_345 : undefined,
        lastError: delivered ? undefined : failure,
      });
    },
  );
}
