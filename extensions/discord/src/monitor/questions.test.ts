import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInteraction as createDiscordInteraction,
  type BaseComponentInteraction,
} from "../internal/discord.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { createDiscordQuestionButton } from "./questions.js";

const dependencies = vi.hoisted(() => ({ authorize: vi.fn(), resolve: vi.fn() }));
vi.mock("./agent-components-guild-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-components-guild-auth.js")>()),
  resolveAuthorizedComponentInteraction: dependencies.authorize,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...actual,
    questionGatewayRuntime: {
      ...actual.questionGatewayRuntime,
      resolveOption: dependencies.resolve,
    },
  };
});

function createInteraction() {
  const client = createInternalTestClient();
  const { post } = attachRestMock(client, {});
  const interaction = createDiscordInteraction(
    client,
    createInternalComponentInteractionPayload({
      id: "interaction-1",
      token: "interaction-token",
      user: {
        id: "user-1",
        username: "Alice",
        discriminator: "0",
        avatar: null,
        global_name: null,
      },
    }),
  ) as BaseComponentInteraction;
  return { interaction, post };
}

const runButton = (interaction: BaseComponentInteraction) =>
  createDiscordQuestionButton({ cfg: {}, accountId: "default" }).run(interaction, {
    id: "ask_0123456789abcdef0123456789abcdef",
    i: "1",
  });
const answered = { status: "answered" as const, questionId: "target", optionValue: "Production" };

describe("Discord question button", () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockResolvedValue(true);
    dependencies.resolve.mockReset();
  });
  it("does not resolve unauthorized clicks", async () => {
    const { interaction, post } = createInteraction();
    dependencies.authorize.mockResolvedValue(false);
    await runButton(interaction);

    expect(dependencies.resolve).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const { interaction } = createInteraction();
    const followUp = vi
      .spyOn(interaction, "followUp")
      .mockRejectedValue(new Error("receipt failed"));
    dependencies.resolve.mockResolvedValue(answered);
    await expect(runButton(interaction)).resolves.toBeUndefined();
    expect(followUp).toHaveBeenCalledExactlyOnceWith({
      content: "Answer submitted.",
      ephemeral: true,
    });
  });

  it.each([
    [false, answered, "Answer submitted."],
    [true, { status: "already-terminal" }, "This question was already answered."],
    [true, new Error("question service unavailable"), "Could not submit this answer."],
  ] as const)(
    "delivers %s acknowledgement feedback: %s",
    async (acknowledged, result, expectedText) => {
      const { interaction, post } = createInteraction();
      if (!acknowledged) {
        post.mockRejectedValueOnce(new Error("temporary connection reset"));
      }
      dependencies.resolve.mockImplementation(async () => {
        if (result instanceof Error) {
          throw result;
        }
        return result;
      });
      await runButton(interaction);

      const callback = "/interactions/interaction-1/interaction-token/callback";
      const feedback = { content: expectedText, flags: MessageFlags.Ephemeral };
      expect(post.mock.calls.map(([path, request]) => [path, request.body])).toEqual([
        [callback, { type: InteractionResponseType.DeferredMessageUpdate }],
        acknowledged
          ? ["/webhooks/app1/interaction-token", feedback]
          : [callback, { type: InteractionResponseType.ChannelMessageWithSource, data: feedback }],
      ]);
      expect(interaction.responseState).toBe(acknowledged ? "deferred-update" : "replied");
    },
  );
});
