// Qa Lab plugin module registers Crabline through the shared QA transport factory contract.
import type { QaBusState } from "./bus-state.js";
import type { QaTransportAdapterFactory } from "./qa-transport-factory.js";

export function createQaCrablineTransportAdapterFactory(
  state?: QaBusState,
): QaTransportAdapterFactory {
  return {
    id: "crabline",
    matches: ({ driver }) => driver === "crabline",
    supportsModuleFlowsFor: ({ channelId, driver }) =>
      driver === "crabline" && channelId === "discord",
    async create(context) {
      if (!state) {
        throw new Error("Crabline QA transport factory requires an owning bus state");
      }
      const [
        { resolveOpenClawCrablineChannelDriverSelection },
        { createQaCrablineTransportDefinition },
      ] = await Promise.all([import("@openclaw/crabline"), import("./crabline-transport.js")]);
      const selection = resolveOpenClawCrablineChannelDriverSelection({
        channel: context.channelId,
      });
      return await createQaCrablineTransportDefinition({
        outputDir: context.outputDir,
        transportPolicy: context.adapterOptions?.transportPolicy,
        selection,
        state,
      });
    },
  };
}
