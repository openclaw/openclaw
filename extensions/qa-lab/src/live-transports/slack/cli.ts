// Qa Lab plugin module implements cli behavior.
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveSlackQaScenarioIds } from "./scenario-selection.js";

type SlackQaAdapterRuntime = typeof import("./adapter.runtime.js");

const loadSlackQaAdapterRuntime = createLazyCliRuntimeLoader<SlackQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);
const loadLiveTransportQaSuiteRuntime = createLazyCliRuntimeLoader<
  typeof import("../shared/live-transport-suite.runtime.js")
>(() => import("../shared/live-transport-suite.runtime.js"));

async function runQaSlack(opts: LiveTransportQaCommandOptions) {
  await (
    await loadLiveTransportQaSuiteRuntime()
  ).runLiveTransportQaSuiteCommand({
    channelId: "slack",
    defaultProviderMode: "live-frontier",
    options: opts,
    selectScenarioIds: ({ scenarioIds }) => resolveSlackQaScenarioIds(scenarioIds),
  });
}

const slackQaAdapterFactory = createLiveTransportQaAdapterFactory({
  id: "slack",
  async create(context) {
    return await (await loadSlackQaAdapterRuntime()).createSlackQaTransportAdapter(context);
  },
});

export const slackQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "slack",
    adapterFactory: slackQaAdapterFactory,
    credentialOptions: {
      sourceDescription: "Credential source for Slack QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the Slack live QA lane against a private bot-to-bot channel harness",
    outputDirHelp: "Slack QA artifact directory",
    run: runQaSlack,
    scenarioHelp: "Run only the named Slack QA scenario (repeatable)",
    sutAccountHelp: "Temporary Slack account id inside the QA gateway config",
  });
