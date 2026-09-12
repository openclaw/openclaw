// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createStandardLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
} from "../shared/live-transport-cli.js";

const loadDiscordQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

export const discordQaCliRegistration: LiveTransportQaCliRegistration =
  createStandardLiveTransportQaCliRegistration({
    channelDriverHelp:
      "Discord transport boundary: live (default) or Crabline local provider server",
    channelId: "discord",
    channelLabel: "Discord",
    async createAdapter(context) {
      return (await loadDiscordQaAdapterRuntime()).createDiscordQaTransportAdapter(context);
    },
    description: "Run Discord QA through the live service or Crabline local provider server",
    listScenariosHelp: "Print the selected Discord scenario ids and exit",
  });
