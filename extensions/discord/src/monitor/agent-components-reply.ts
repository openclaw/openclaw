import type { AgentComponentInteraction } from "./agent-components.types.js";

export async function replySilently(
  interaction: AgentComponentInteraction,
  params: { content: string; ephemeral?: boolean },
  onError?: (error: unknown) => void,
) {
  try {
    await interaction[interaction.responseState === "deferred-update" ? "followUp" : "reply"](
      params,
    );
  } catch (error) {
    onError?.(error);
  }
}
