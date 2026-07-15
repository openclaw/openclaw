// Qa Lab plugin module implements cli behavior.
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveWhatsAppQaScenarioIds } from "./scenario-selection.js";

type WhatsAppQaAdapterRuntime = typeof import("./adapter.runtime.js");

const loadWhatsAppQaAdapterRuntime = createLazyCliRuntimeLoader<WhatsAppQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);
const loadLiveTransportQaSuiteRuntime = createLazyCliRuntimeLoader<
  typeof import("../shared/live-transport-suite.runtime.js")
>(() => import("../shared/live-transport-suite.runtime.js"));

async function runQaWhatsApp(opts: LiveTransportQaCommandOptions) {
  await (
    await loadLiveTransportQaSuiteRuntime()
  ).runLiveTransportQaSuiteCommand({
    channelId: "whatsapp",
    defaultProviderMode: "live-frontier",
    options: opts,
    selectScenarioIds: ({ providerMode, scenarioIds }) =>
      resolveWhatsAppQaScenarioIds({
        providerMode: providerMode ?? "live-frontier",
        scenarioIds,
      }),
  });
}

const whatsappQaAdapterFactory = createLiveTransportQaAdapterFactory({
  id: "whatsapp",
  async create(context) {
    return await (await loadWhatsAppQaAdapterRuntime()).createWhatsAppQaTransportAdapter(context);
  },
});

export const whatsappQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "whatsapp",
    adapterFactory: whatsappQaAdapterFactory,
    credentialOptions: {
      sourceDescription: "Credential source for WhatsApp QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the WhatsApp live QA lane against two pre-linked Web sessions",
    outputDirHelp: "WhatsApp QA artifact directory",
    run: runQaWhatsApp,
    scenarioHelp: "Run only the named WhatsApp QA scenario (repeatable)",
    sutAccountHelp: "Temporary WhatsApp account id inside the QA gateway config",
  });
