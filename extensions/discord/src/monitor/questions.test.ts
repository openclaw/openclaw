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
    const resolveQuestion = dependencies.resolve;
    dependencies.authorize.mockResolvedValue(false);
    await runButton(interaction);

    expect(resolveQuestion).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const { interaction } = createInteraction();
    const followUp = vi
      .spyOn(interaction, "followUp")
      .mockRejectedValue(new Error("receipt failed"));
    dependencies.resolve.mockResolvedValue(answered);
    await expect(runButton(interaction)).resolves.toBeUndefined();
    expect(followUp).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith({
      content: "Answer submitted.",
      ephemeral: true,
    });
  });

  it.each([
    {
      name: "submitted answer",
      acknowledged: false,
      result: answered,
      expectedText: "Answer submitted.",
    },
    {
      name: "already answered question",
      acknowledged: true,
      result: { status: "already-terminal" as const, reason: "already-terminal" as const },
      expectedText: "This question was already answered.",
    },
    {
      name: "question resolution failure",
      acknowledged: true,
      error: new Error("question service unavailable"),
      expectedText: "Could not submit this answer.",
    },
  ])("delivers $name feedback when acknowledgement is $acknowledged", async (testCase) => {
    const { interaction, post } = createInteraction();
    if (!testCase.acknowledged) {
      post.mockRejectedValueOnce(new Error("temporary connection reset"));
    }
    const resolveQuestion = dependencies.resolve.mockImplementation(async () => {
      if (testCase.error) {
        throw testCase.error;
      }
      return testCase.result;
    });
    await runButton(interaction);

    expect(resolveQuestion).toHaveBeenCalledOnce();
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/interactions/interaction-1/interaction-token/callback",
      {
        body: { type: InteractionResponseType.DeferredMessageUpdate },
      },
    );
    if (testCase.acknowledged) {
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/webhooks/app1/interaction-token",
        { body: { content: testCase.expectedText, flags: MessageFlags.Ephemeral } },
        undefined,
      );
      expect(interaction.responseState).toBe("deferred-update");
    } else {
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/interactions/interaction-1/interaction-token/callback",
        {
          body: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: testCase.expectedText, flags: MessageFlags.Ephemeral },
          },
        },
      );
      expect(interaction.responseState).toBe("replied");
    }
  });
});
