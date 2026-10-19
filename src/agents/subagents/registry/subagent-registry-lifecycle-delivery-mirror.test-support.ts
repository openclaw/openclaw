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
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = SubagentLifecycleOptions;

export function buildExpectedAnnounceIdempotencyKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
}

/** Delivery-mirror crediting: a failed direct announce can still be proven by requester history. */
export function registerDeliveryMirrorCases({
  createLifecycleController,
  waitForLifecycleState,
  callGateway,
  blockSubagentCompletionDelivery,
  logAnnounceGiveUp,
}: {
  createLifecycleController: (
    options: { entry: SubagentRunRecord } & Partial<LifecycleControllerFixtureOptions>,
  ) => SubagentLifecycleController;
  waitForLifecycleState: <T>(assertion: () => T | Promise<T>) => Promise<T>;
  callGateway: Mock<(opts: CallGatewayOptions) => Promise<unknown>>;
  blockSubagentCompletionDelivery: Mock;
  logAnnounceGiveUp: Mock;
}) {
  async function runNoReplyMirrorScenario(params: {
    timestamp: number;
    text?: string;
    idempotencyKey?: string;
    idempotencyKeyForEntry?: (entry: SubagentRunRecord) => string;
    requester?: Pick<SubagentRunRecord, "requesterSessionKey" | "requesterAgentId">;
  }): Promise<SubagentRunRecord> {
    // A failed direct announce can still be mirrored from the requester history;
    // the idempotency key prevents stale or unrelated assistant text from winning.
    const entry = createLifecycleRunEntry({
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
      ...params.requester,
    });
    const text = params.text ?? "final completion reply";
    const idempotencyKey =
      params.idempotencyKeyForEntry?.(entry) ??
      params.idempotencyKey ??
      `${buildExpectedAnnounceIdempotencyKey(entry)}:internal-source-reply:0`;
    const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
      async (announceParams) => {
        await announceParams.onDeliveryResult?.({
          delivered: false,
          path: "direct",
          error: "completion agent did not produce a visible reply",
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
            timestamp: params.timestamp,
            idempotencyKey,
          },
        ],
      };
    });

    await createLifecycleController({
      entry,
      captureSubagentCompletionReply: vi.fn(async () => text),
      beforeWrite: vi.fn(),
      runSubagentAnnounceFlow,
    }).completeSubagentRun(
      makeSubagentCompletion(entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text },
      }),
    );
    return entry;
  }

  it.each([
    { source: "current" },
    { source: "long reply" },
    { source: "message tool" },
    { source: "child run" },
    { source: "stale" },
    { source: "sibling" },
  ])("credits only current-run requester delivery mirrors ($source)", async ({ source }) => {
    const delivered = source !== "stale" && source !== "sibling";
    const entry = await runNoReplyMirrorScenario({
      timestamp: source === "stale" ? 1_999 : 12_345,
      text: source === "long reply" ? "long completion reply ".repeat(500) : undefined,
      idempotencyKeyForEntry: (candidate) => {
        if (source === "child run") {
          return `${candidate.runId}:message-tool:1`;
        }
        if (source === "sibling") {
          return `${buildAnnounceIdempotencyKey(
            buildAnnounceIdFromChildRun({
              childSessionKey: "agent:main:subagent:sibling",
              childRunId: "run-sibling",
            }),
          )}:internal-source-reply:0`;
        }
        return `${buildExpectedAnnounceIdempotencyKey(candidate)}:${source === "message tool" ? "message-tool:" : ""}internal-source-reply:0`;
      },
    });
    await waitForLifecycleState(() =>
      expect(
        delivered
          ? readLifecycleRun(entry).cleanupCompletedAt
          : readLifecycleRun(entry).delivery?.suspendedAt,
      ).toBeTypeOf("number"),
    );
    expect(callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: entry.requesterSessionKey, limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: delivered ? "delivered" : "suspended",
      deliveredAt: delivered ? 12_345 : undefined,
      announcedAt: delivered ? 12_345 : undefined,
      lastError: delivered ? undefined : "completion agent did not produce a visible reply",
    });
    if (delivered) {
      expect(readLifecycleRun(entry).delivery?.payload).toBeUndefined();
      expect(readLifecycleRun(entry).delivery?.attemptCount).toBeUndefined();
      expect(logAnnounceGiveUp).not.toHaveBeenCalled();
    } else {
      expect(blockSubagentCompletionDelivery).toHaveBeenCalledWith({
        subagent: expect.objectContaining({
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          completion: expect.objectContaining({ resultText: "final completion reply" }),
        }),
        reason: "completion agent did not produce a visible reply",
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

  it("credits a delivery mirror for an unqualified requester in a multi-agent Gateway", async () => {
    const entry = await runNoReplyMirrorScenario({
      timestamp: 12_345,
      requester: { requesterSessionKey: "global", requesterAgentId: "ops" },
    });
    await waitForLifecycleState(() =>
      expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number"),
    );
    expect(callGateway).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "global", agentId: "ops", limit: 25, maxChars: 128 * 1024 },
      timeoutMs: 5_000,
    });
    expect(readLifecycleRun(entry).delivery).toMatchObject({
      status: "delivered",
      deliveredAt: 12_345,
      lastError: undefined,
    });
    expect(logAnnounceGiveUp).not.toHaveBeenCalled();
  });
}
