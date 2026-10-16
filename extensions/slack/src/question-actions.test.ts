// Slack question envelope and feedback tests.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeSlackQuestionAction,
  encodeSlackQuestionAction,
  resolveSlackQuestionAction,
} from "./question-actions.js";

describe("Slack question actions", () => {
  const questionId = "ask_0123456789abcdef0123456789abcdef";
  afterEach(() => vi.restoreAllMocks());

  it("round-trips a compact option index within Slack's value limit", () => {
    const value = encodeSlackQuestionAction({ questionId, optionIndex: 3 });

    expect(value).toBe(`slq1:${questionId}:3`);
    expect(value).toHaveLength(43);
    expect(value?.length).toBeLessThanOrEqual(2000);
    expect(decodeSlackQuestionAction(value)).toEqual({ questionId, optionIndex: 3 });
  });

  it.each([
    [{ status: "answered", questionId: "target", optionValue: "Production" }, "Answer submitted."],
    [{ status: "already-terminal", reason: "not-found" }, "This question was already answered."],
  ] as const)("shows ephemeral-ready outcome feedback", async (result, expectedText) => {
    const respond = vi.fn(async () => undefined);
    const cfg = {};
    const resolveOption = vi
      .spyOn(questionGatewayRuntime, "resolveOption")
      .mockResolvedValue(result);

    await resolveSlackQuestionAction({
      action: { questionId, optionIndex: 1 },
      cfg,
      accountId: "default",
      userId: "U123",
      respond,
    });

    expect(resolveOption).toHaveBeenCalledExactlyOnceWith({
      cfg,
      questionId,
      optionIndex: 1,
      senderId: "U123",
      clientDisplayName: "Slack question (default)",
    });
    expect(respond).toHaveBeenCalledWith(expectedText);
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const respond = vi.fn(async () => {
      throw new Error("receipt failed");
    });

    vi.spyOn(questionGatewayRuntime, "resolveOption").mockResolvedValue({
      status: "answered",
      questionId: "target",
      optionValue: "Production",
    });

    await expect(
      resolveSlackQuestionAction({
        action: { questionId, optionIndex: 1 },
        cfg: {} as never,
        accountId: "default",
        userId: "U123",
        respond,
      }),
    ).resolves.toBeUndefined();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith("Answer submitted.");
  });
});
