import {
  createLazyCliRuntimeLoader,
  createStandardLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
} from "../shared/live-transport-cli.js";

const loadDiscordQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

const standardDiscordQaCliRegistration = createStandardLiveTransportQaCliRegistration({
  channelId: "discord",
  channelLabel: "Discord",
  async createAdapter(context) {
    return (await loadDiscordQaAdapterRuntime()).createDiscordQaTransportAdapter(context);
  },
  description: "Run Discord QA through the live service or Crabline local provider server",
  listScenariosHelp: "Print the selected Discord scenario ids and exit",
});

export const discordQaCliRegistration: LiveTransportQaCliRegistration = {
  ...standardDiscordQaCliRegistration,
  register(qa) {
    standardDiscordQaCliRegistration.register(qa);
    const command = qa.commands.find((candidate) => candidate.name() === "discord");
    if (!command) {
      throw new Error("missing Discord QA command after registration");
    }
    command.option(
      "--channel-driver <live|crabline>",
      "Channel driver: live (default) or Crabline local provider server",
    );
  },
};
