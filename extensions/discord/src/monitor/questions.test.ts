// Discord question component feedback tests.
import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "../internal/discord.js";
import { createDiscordQuestionButton } from "./questions.js";

function createInteraction(): ButtonInteraction {
  return {
    userId: "user-1",
    reply: vi.fn(),
    acknowledge: vi.fn(),
    followUp: vi.fn(),
  } as unknown as ButtonInteraction;
}

describe("Discord question button", () => {
  it.each([
    [{ status: "answered", questionId: "target", optionValue: "Production" }, "Answer submitted."],
    [
      { status: "already-terminal", reason: "already-terminal" },
      "This question was already answered.",
    ],
  ] as const)("shows ephemeral outcome feedback", async (result, expectedText) => {
    const interaction = createInteraction();
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => true),
      resolveQuestion: vi.fn(async () => result),
    });

    await button.run(interaction, {
      id: "ask_0123456789abcdef0123456789abcdef",
      i: "1",
    });

    expect(interaction.acknowledge).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({ content: expectedText, ephemeral: true });
  });

  it("does not resolve unauthorized clicks", async () => {
    const interaction = createInteraction();
    const resolveQuestion = vi.fn();
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => false),
      resolveQuestion,
    });

    await button.run(interaction, {
      id: "ask_0123456789abcdef0123456789abcdef",
      i: "1",
    });

    expect(resolveQuestion).not.toHaveBeenCalled();
    expect(interaction.acknowledge).not.toHaveBeenCalled();
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const interaction = createInteraction();
    vi.mocked(interaction.followUp).mockRejectedValue(new Error("receipt failed"));
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => true),
      resolveQuestion: vi.fn(async () => ({
        status: "answered" as const,
        questionId: "target",
        optionValue: "Production",
      })),
    });

    await expect(
      button.run(interaction, {
        id: "ask_0123456789abcdef0123456789abcdef",
        i: "1",
      }),
    ).resolves.toBeUndefined();
    expect(interaction.followUp).toHaveBeenCalledOnce();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "Answer submitted.",
      ephemeral: true,
    });
  });
});
