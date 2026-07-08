// Qa Lab plugin module implements Matrix live transport CLI behavior.
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { MATRIX_QA_ALL_SCENARIO_IDS } from "./profiles.js";

const loadMatrixQaCliRuntime = createLazyCliRuntimeLoader<typeof import("./cli.runtime.js")>(
  () => import("./cli.runtime.js"),
);
const loadMatrixQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  await (await loadMatrixQaCliRuntime()).runQaMatrixCommand(opts);
}

export const matrixQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> =
  {
    id: "matrix",
    scenarioIds: MATRIX_QA_ALL_SCENARIO_IDS,
    matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
    async create(context) {
      return await (await loadMatrixQaAdapterRuntime()).createMatrixQaTransportAdapter(context);
    },
  };

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    adapterFactory: matrixQaAdapterFactory,
    defaultProviderMode: "live-frontier",
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    profileHelp:
      "QA Lab Matrix profile: all, fast, release, transport, media, e2ee-smoke, e2ee-deep, or e2ee-cli (default: all)",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    failFastHelp: "Stop after the first failed Matrix QA scenario",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });
