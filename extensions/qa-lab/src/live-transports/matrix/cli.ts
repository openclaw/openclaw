// Qa Lab plugin module implements Matrix live transport CLI behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  loadLiveTransportQaSuiteRuntime,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveCatalogLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";

const loadMatrixQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  const run = async () => {
    const runtime = await loadLiveTransportQaSuiteRuntime();
    await runtime.runLiveTransportQaSuiteCommand({
      channelId: "matrix",
      credentialMode: "env-only",
      defaultProviderMode: "live-frontier",
      envCredentialReason: "its homeserver is disposable and local.",
      laneLabel: "Matrix",
      options: opts,
      selectScenarioIds: (selection) =>
        resolveCatalogLiveTransportQaScenarioIds({
          channelId: "matrix",
          primaryModel: selection.primaryModel,
          providerMode: selection.providerMode,
          scenarioIds: selection.scenarioIds,
          supportsModuleFlows: true,
        }),
    });
  };
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    adapterFactory: createLiveTransportQaAdapterFactory({
      id: "matrix",
      supportsModuleFlows: true,
      // Every worker owns a uniquely named disposable homeserver, Gateway, and state tree.
      isolatesInstances: true,
      async prepareSelectedScenarios(scenarioIds) {
        await (await loadMatrixQaAdapterRuntime()).prepareMatrixQaSelectedScenarios(scenarioIds);
      },
      async create(context) {
        return (await loadMatrixQaAdapterRuntime()).createMatrixQaTransportAdapter(context);
      },
    }),
    defaultProviderMode: "live-frontier",
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    failFastHelp: "Stop after the first failed Matrix QA scenario",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });
