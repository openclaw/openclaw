import type { AgentComponentInteraction } from "./agent-components.types.js";

export async function replySilently(
  interaction: AgentComponentInteraction,
  params: { content: string; ephemeral?: boolean },
  onError?: (error: unknown) => void,
) {
  try {
    if (interaction.responseState === "deferred-update") {
      await interaction.followUp({ ...params, ephemeral: true });
    } else {
      await interaction.reply(params);
    }
  } catch (error) {
    onError?.(error);
  }
}
