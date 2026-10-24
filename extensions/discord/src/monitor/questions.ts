import { ComponentType } from "discord-api-types/v10";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type {
  BaseComponentInteraction,
  BaseMessageInteractiveComponent,
  ComponentData,
} from "../internal/discord.js";
import { parseDiscordQuestionData } from "../question-custom-id.js";
import { resolveAuthorizedComponentInteraction } from "./agent-components-guild-auth.js";
import type { AgentComponentContext } from "./agent-components.types.js";

type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
export function createDiscordQuestionButton(params: {
  cfg: ResolveQuestionParams["cfg"];
  accountId: string;
  authContext?: AgentComponentContext;
}): BaseMessageInteractiveComponent {
  const authContext = params.authContext ?? { cfg: params.cfg, accountId: params.accountId };
  return {
    type: ComponentType.Button,
    customId: "ocq:id=seed;i=0",
    async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
      const callback = parseDiscordQuestionData(data);
      if (!callback) {
        await interaction.reply({ content: "This question is no longer valid.", ephemeral: true });
        return;
      }
      if (
        !(await resolveAuthorizedComponentInteraction({
          ctx: authContext,
          interaction,
          label: "discord question",
          componentLabel: "button",
          unauthorizedReply: "You are not authorized to answer this question.",
        }))
      ) {
        return;
      }
      try {
        await interaction.acknowledge();
      } catch {
        // The Gateway can accept the answer even when Discord cannot acknowledge it.
      }
      let content: string;
      try {
        const result = await questionGatewayRuntime.resolveOption({
          cfg: params.cfg,
          questionId: callback.questionId,
          optionIndex: callback.optionIndex,
          senderId: interaction.userId,
          clientDisplayName: `Discord question (${params.accountId})`,
        });
        content =
          result.status === "answered"
            ? "Answer submitted."
            : "This question was already answered.";
      } catch {
        content = "Could not submit this answer.";
      }
      try {
        const feedback = { content, ephemeral: true };
        // A rejected acknowledgement leaves the initial callback available, not the webhook.
        await (interaction.responseState === "unacknowledged"
          ? interaction.reply(feedback)
          : interaction.followUp(feedback));
      } catch {
        // Gateway state may already be committed; receipt delivery is best-effort.
      }
    },
  };
}
