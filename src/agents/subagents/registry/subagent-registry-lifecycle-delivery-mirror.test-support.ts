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
  expectUndefinedFields,
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
  blockSubagentCompletionDelivery,
  logAnnounceGiveUp,
}: Omit<LifecycleTestDrivers, "createRunEntry"> & {
  callGateway: Mock<(opts: CallGatewayOptions) => Promise<unknown>>;
  blockSubagentCompletionDelivery: Mock;
  logAnnounceGiveUp: Mock;
}) {
  const failure = "completion agent did not produce a visible reply";
  it.each([
    "current",
    "long reply",
    "message tool",
    "child run",
    "stale",
    "sibling",
    "unqualified",
  ])("credits only current-run requester delivery mirrors (%s)", async (source) => {
    const unqualified = source === "unqualified";
    const entry = createLifecycleRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      ...(unqualified ? { requesterSessionKey: "global", requesterAgentId: "ops" } : {}),
    });
    const text =
      source === "long reply" ? "long completion reply ".repeat(500) : "final completion reply";
    const mirrored =
      source === "sibling"
        ? { ...entry, childSessionKey: "agent:main:subagent:sibling", runId: "run-sibling" }
        : entry;
    const idempotencyKey =
      source === "child run"
        ? `${entry.runId}:message-tool:1`
        : `${buildExpectedAnnounceIdempotencyKey(mirrored)}:${source === "message tool" ? "message-tool:" : ""}internal-source-reply:0`;
    const runSubagentAnnounceFlow = vi.fn<SubagentLifecycleOptions["runSubagentAnnounceFlow"]>(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: failure,
        });
        return "retryable" as const;
      },
    );
    callGateway.mockImplementationOnce(async (request) => {
      // Multi-agent Gateways refuse an unqualified session key without an explicit agent.
      const { sessionKey, agentId } = (request.params ?? {}) as Record<string, unknown>;
      if (typeof sessionKey === "string" && !sessionKey.startsWith("agent:") && !agentId) {
        throw new Error(`session key "${sessionKey}" requires an agent selection`);
      }
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
      runSubagentAnnounceFlow,
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
    expect(callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: {
        sessionKey: entry.requesterSessionKey,
        ...(unqualified ? { agentId: "ops" } : {}),
        limit: 25,
        maxChars: 128 * 1024,
      },
      timeoutMs: 5_000,
    });
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: delivered ? "delivered" : "suspended",
      deliveredAt: delivered ? 12_345 : undefined,
      announcedAt: delivered ? 12_345 : undefined,
      lastError: delivered ? undefined : failure,
    });
    if (delivered) {
      expectUndefinedFields(readLifecycleRun(entry).delivery, ["payload", "attemptCount"]);
      expect(logAnnounceGiveUp).not.toHaveBeenCalled();
    } else {
      expect(blockSubagentCompletionDelivery).toHaveBeenCalledWith({
        subagent: expect.objectContaining({
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          completion: expect.objectContaining({ resultText: "final completion reply" }),
        }),
        reason: failure,
        suspendedReason: "expiry",
      });
      expect(logAnnounceGiveUp).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: entry.runId,
          requesterSessionKey: entry.requesterSessionKey,
        }),
        "expiry",
      );
    }
  });
}
