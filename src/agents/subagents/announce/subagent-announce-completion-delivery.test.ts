// Completion predicates read recorded facts, not rendered placeholder wording.
import { describe, expect, it, vi } from "vitest";
import { hasFailedSubagentNoOutputCompletion } from "../../internal-event-contract.js";
import { hasMessagingToolDeliveryToSource } from "./subagent-announce-completion-delivery.js";

const failedChild = { type: "task_completion", source: "subagent", status: "error" } as const;

describe("hasFailedSubagentNoOutputCompletion", () => {
  it.each([
    [
      "recorded no visible result",
      { ...failedChild, result: "(no output)", noVisibleResult: true },
      true,
    ],
    [
      "reworded placeholder",
      { ...failedChild, result: "(nothing to report)", noVisibleResult: true },
      true,
    ],
    ["real result resembling placeholder", { ...failedChild, result: "(no output)" }, false],
    [
      "successful child",
      { ...failedChild, status: "ok", result: "(no output)", noVisibleResult: true },
      false,
    ],
    [
      "non-subagent source",
      { ...failedChild, source: "image_generation", result: "(no output)", noVisibleResult: true },
      false,
    ],
  ] as const)("classifies %s from the recorded result fact", (_label, event, expected) => {
    expect(hasFailedSubagentNoOutputCompletion([event])).toBe(expected);
  });

  it("reports nothing for an absent or empty event list", () => {
    expect(hasFailedSubagentNoOutputCompletion(undefined)).toBe(false);
    expect(hasFailedSubagentNoOutputCompletion([])).toBe(false);
  });
});

describe("hasMessagingToolDeliveryToSource", () => {
  const deliveryTarget = {
    channel: "slack",
    accountId: "secondary",
    to: "user:U000000001",
    threadId: "1700000000.000001",
  };
  const result = {
    didSendViaMessagingTool: true,
    messagingToolSentTargets: [
      {
        tool: "message",
        provider: "slack",
        accountId: "secondary",
        to: "D000000001",
        threadId: "1700000000.000001",
        sourceReplyFinal: true,
      },
    ],
  };

  it("credits a provider-native conversation after exact recipient resolution", async () => {
    const resolveEquivalentTarget = vi.fn().mockResolvedValue("user:U000000001");

    await expect(
      hasMessagingToolDeliveryToSource(result, deliveryTarget, {
        requireFinalReply: true,
        resolveEquivalentTarget,
      }),
    ).resolves.toBe(true);
    expect(resolveEquivalentTarget).toHaveBeenCalledOnce();
  });

  it.each([
    ["wrong recipient", "user:U000000002"],
    ["failed recipient lookup", undefined],
  ] as const)("does not credit %s", async (_label, equivalentTarget) => {
    await expect(
      hasMessagingToolDeliveryToSource(result, deliveryTarget, {
        requireFinalReply: true,
        resolveEquivalentTarget: async () => equivalentTarget,
      }),
    ).resolves.toBe(false);
  });

  it("does not resolve an omitted target account against a non-default source", async () => {
    const resolveEquivalentTarget = vi.fn().mockResolvedValue("user:U000000001");
    const omittedAccountResult = {
      ...result,
      messagingToolSentTargets: [{ ...result.messagingToolSentTargets[0], accountId: undefined }],
    };

    await expect(
      hasMessagingToolDeliveryToSource(omittedAccountResult, deliveryTarget, {
        requireFinalReply: true,
        resolveEquivalentTarget,
      }),
    ).resolves.toBe(false);
    expect(resolveEquivalentTarget).not.toHaveBeenCalled();
  });

  it("keeps a wrong thread uncredited after recipient resolution", async () => {
    const wrongThreadResult = {
      ...result,
      messagingToolSentTargets: [
        { ...result.messagingToolSentTargets[0], threadId: "1700000000.000002" },
      ],
    };

    await expect(
      hasMessagingToolDeliveryToSource(wrongThreadResult, deliveryTarget, {
        requireFinalReply: true,
        resolveEquivalentTarget: async () => "user:U000000001",
      }),
    ).resolves.toBe(false);
  });

  it("passes caller cancellation to provider-native recipient resolution", async () => {
    const controller = new AbortController();
    const resolveEquivalentTarget = vi.fn(
      async (_target: unknown, _deliveryTarget: unknown, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return undefined;
      },
    );
    const pending = hasMessagingToolDeliveryToSource(result, deliveryTarget, {
      requireFinalReply: true,
      signal: controller.signal,
      resolveEquivalentTarget,
    });

    controller.abort();

    await expect(pending).resolves.toBe(false);
    expect(resolveEquivalentTarget).toHaveBeenCalledWith(
      result.messagingToolSentTargets[0],
      deliveryTarget,
      controller.signal,
    );
  });
});
