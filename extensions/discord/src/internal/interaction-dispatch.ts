import { InteractionType, type APIInteraction } from "discord-api-types/v10";
import {
  type DiscordCommand,
  deferCommandInteractionIfNeeded,
  resolveFocusedCommandOptionAutocompleteHandler,
} from "./commands.js";
import type { BaseMessageInteractiveComponent } from "./components.base.js";
import type { Modal } from "./components.modal.js";
import {
  AutocompleteInteraction,
  BaseComponentInteraction,
  CommandInteraction,
  ModalInteraction,
  createInteraction,
  type RawInteraction,
} from "./interactions.js";

type DispatchClient = Parameters<typeof createInteraction>[0] & {
  commands: DiscordCommand[];
  componentHandler: {
    resolve(
      customId: string,
      options?: { componentType?: number },
    ): BaseMessageInteractiveComponent | undefined;
  };
  modalHandler: { resolve(customId: string): Modal | undefined };
};

export async function dispatchInteraction(
  client: DispatchClient,
  rawData: APIInteraction,
): Promise<void> {
  const interaction = createInteraction(client, rawData as RawInteraction);
  if (rawData.type === InteractionType.ApplicationCommandAutocomplete) {
    const command = client.commands.find((entry) => entry.name === rawData.data?.name);
    if (!command) {
      return;
    }
    const autocompleteInteraction = interaction as AutocompleteInteraction;
    const optionAutocomplete = resolveFocusedCommandOptionAutocompleteHandler(
      command,
      autocompleteInteraction,
    );
    if (optionAutocomplete) {
      await optionAutocomplete(autocompleteInteraction);
      return;
    }
    if (command.commandKind === "leaf") {
      await command.autocomplete(autocompleteInteraction);
    }
    return;
  }
  try {
    await dispatchAcknowledgeableInteraction(client, rawData, interaction);
  } catch (error) {
    // A handler that throws after deferring leaves Discord showing a spinner
    // forever, so surface the failure before rethrowing for the caller's log.
    await reportInteractionFailure(interaction);
    throw error;
  }
}

async function dispatchAcknowledgeableInteraction(
  client: DispatchClient,
  rawData: APIInteraction,
  interaction: ReturnType<typeof createInteraction>,
): Promise<void> {
  if (rawData.type === InteractionType.ApplicationCommand) {
    const command = client.commands.find((entry) => entry.name === rawData.data?.name);
    if (command) {
      await deferCommandInteractionIfNeeded(command, interaction as CommandInteraction);
      await command.run(interaction as CommandInteraction);
    }
    return;
  }
  if (rawData.type === InteractionType.MessageComponent) {
    const customId = rawData.data?.custom_id;
    if (!customId) {
      return;
    }
    const componentInteraction = interaction as BaseComponentInteraction;
    const component = client.componentHandler.resolve(customId, {
      componentType: rawData.data?.component_type,
    });
    if (component) {
      await deferComponentInteractionIfNeeded(component, componentInteraction);
      await component.run(componentInteraction, component.customIdParser(customId).data);
    }
    return;
  }
  if (rawData.type === InteractionType.ModalSubmit) {
    const customId = rawData.data?.custom_id;
    if (!customId) {
      return;
    }
    const modal = client.modalHandler.resolve(customId);
    if (modal) {
      await modal.run(interaction as ModalInteraction, modal.customIdParser(customId).data);
    }
  }
}

// Exceptions can contain paths, config and provider responses; keep details in Gateway logs.
const INTERACTION_FAILURE_NOTICE = "Command failed. Check the Gateway logs for details.";

// Only a confirmed deferred reply owns an unanswered spinner. Deferred updates
// refer to existing channel content; other states must not create a second reply.
async function reportInteractionFailure(
  interaction: ReturnType<typeof createInteraction>,
): Promise<void> {
  // A follow-up can consume the placeholder; never overwrite its visible output.
  if (interaction.responseState !== "deferred" || interaction.hasSentFollowUp) {
    return;
  }
  try {
    // Recheck inside the response queue after in-flight follow-ups settle.
    // Pin mentions so future notice text cannot introduce channel pings.
    await interaction.editDeferredPlaceholderIfUnanswered({
      content: INTERACTION_FAILURE_NOTICE,
      allowed_mentions: { parse: [] },
    });
  } catch {
    // Ignored: the caller rethrows and logs the original failure.
  }
}

function resolveConditionalComponentOption(
  value: boolean | ((interaction: BaseComponentInteraction) => boolean),
  interaction: BaseComponentInteraction,
): boolean {
  return typeof value === "function" ? value(interaction) : value;
}

async function deferComponentInteractionIfNeeded(
  component: BaseMessageInteractiveComponent,
  interaction: BaseComponentInteraction,
): Promise<void> {
  if (!resolveConditionalComponentOption(component.defer, interaction)) {
    return;
  }
  if (resolveConditionalComponentOption(component.ephemeral, interaction)) {
    await interaction.defer({ ephemeral: true });
    return;
  }
  await interaction.acknowledge();
}
