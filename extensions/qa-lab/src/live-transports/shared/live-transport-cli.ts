import type { Command } from "commander";
import {
  createLiveTransportQaCliRegistration as createQaRunnerCliRegistration,
  type LiveTransportQaCommandOptions as QaRunnerCommandOptions,
  type LiveTransportQaCliRegistrationOptions as QaRunnerCliRegistrationOptions,
  type QaRunnerCliRegistration,
} from "openclaw/plugin-sdk/qa-runner-runtime";
import { collectString, parseQaCliPositiveIntegerOption } from "../../cli-options.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, formatQaProviderModeHelp } from "../../providers/index.js";
import type { QaTransportAdapterFactory } from "../../qa-transport-registry.js";

export type LiveTransportQaCommandOptions = QaRunnerCommandOptions & {
  channelDriver?: string;
  concurrency?: number;
  doctor?: boolean;
  scenarioFiles?: string[];
};

export type LiveTransportQaCliRegistration = Omit<QaRunnerCliRegistration, "adapterFactory"> & {
  adapterFactory?: QaTransportAdapterFactory;
};

type LiveTransportQaCliRegistrationOptions = Omit<
  QaRunnerCliRegistrationOptions,
  "adapterFactory" | "concurrency" | "run"
> & {
  adapterFactory?: QaTransportAdapterFactory;
  agentE2e?: boolean;
  run: (options: LiveTransportQaCommandOptions) => Promise<void>;
};

export function createLazyCliRuntimeLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  return async () => {
    promise ??= load();
    return await promise;
  };
}

// All dedicated commands share one memoized import of the consolidated suite host.
export const loadLiveTransportQaSuiteRuntime = createLazyCliRuntimeLoader<
  typeof import("./live-transport-suite.runtime.js")
>(() => import("./live-transport-suite.runtime.js"));

type QaLabLiveTransportQaCliRegistrationOptions = Omit<
  LiveTransportQaCliRegistrationOptions,
  "allowFailuresHelp" | "defaultProviderMode" | "providerModeHelp"
> & {
  defaultProviderMode?: LiveTransportQaCliRegistrationOptions["defaultProviderMode"];
};

export function createLiveTransportQaCliRegistration(
  params: QaLabLiveTransportQaCliRegistrationOptions,
) {
  const options = {
    ...params,
    allowFailuresHelp: "Write artifacts without setting a failing exit code when scenarios fail",
    concurrency:
      params.adapterFactory?.isolatesInstances === true
        ? {
            help: "Scenario worker concurrency (bounded by the transport limit)",
            parse: (value: string) => parseQaCliPositiveIntegerOption(value, "--concurrency"),
          }
        : undefined,
    defaultProviderMode: params.defaultProviderMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
    providerModeHelp: formatQaProviderModeHelp(),
  };
  if (!params.agentE2e) {
    return createQaRunnerCliRegistration(options);
  }
  return {
    commandName: params.commandName,
    adapterFactory: params.adapterFactory,
    register(qa: Command) {
      const registration = createQaRunnerCliRegistration({
        ...options,
        async run(mapped) {
          const selection = command.opts<{ doctor?: boolean; scenarioFile?: string[] }>();
          await params.run({
            ...mapped,
            ...(selection.doctor ? { doctor: true } : {}),
            ...(selection.scenarioFile?.length ? { scenarioFiles: selection.scenarioFile } : {}),
            ...((selection.doctor || selection.scenarioFile?.length) &&
            command.getOptionValueSource("providerMode") === "default"
              ? { providerMode: undefined }
              : {}),
          });
        },
      });
      registration.register(qa);
      const registeredCommand = qa.commands.find(
        (candidate) => candidate.name() === params.commandName,
      );
      if (!registeredCommand) {
        throw new Error(`missing ${params.commandName} QA command after registration`);
      }
      const command = registeredCommand;
      command.option("--doctor", "Run only the native agent E2E readiness recipe", false).option(
        "--scenario-file <path>",
        "Run a complete agent E2E YAML scenario (repeatable; defaults: convex, ci, mock-openai)",
        (value: string, previous: string[]) => {
          if (!value.trim()) {
            throw new Error("--scenario-file must name a non-empty YAML file path.");
          }
          return collectString(value, previous);
        },
        [],
      );
    },
  };
}

export function createLiveTransportQaAdapterFactory(params: {
  create: NonNullable<LiveTransportQaCliRegistrationOptions["adapterFactory"]>["create"];
  id: string;
  isolatesInstances?: boolean;
  supportsModuleFlows?: true;
  prepareSelectedScenarios?: QaTransportAdapterFactory["prepareSelectedScenarios"];
}): NonNullable<LiveTransportQaCliRegistrationOptions["adapterFactory"]> {
  return {
    id: params.id,
    isolatesInstances: params.isolatesInstances,
    supportsModuleFlows: params.supportsModuleFlows,
    ...(params.prepareSelectedScenarios
      ? { prepareSelectedScenarios: params.prepareSelectedScenarios }
      : {}),
    matches: ({ channelId, driver }) => driver === "live" && channelId === params.id,
    create: params.create,
  };
}

export function createStandardLiveTransportQaCliRegistration(params: {
  channelId: string;
  channelLabel: string;
  agentE2e?: boolean;
  createAdapter: NonNullable<LiveTransportQaCliRegistrationOptions["adapterFactory"]>["create"];
  description: string;
  listScenariosHelp?: string;
}): LiveTransportQaCliRegistration {
  const adapterFactory = createLiveTransportQaAdapterFactory({
    id: params.channelId,
    supportsModuleFlows: true,
    create: params.createAdapter,
  });
  return createLiveTransportQaCliRegistration({
    commandName: params.channelId,
    adapterFactory,
    agentE2e: params.agentE2e,
    credentialOptions: {
      sourceDescription: `Credential source for ${params.channelLabel} QA: env or convex (default: env)`,
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: params.description,
    listScenariosHelp:
      params.listScenariosHelp ??
      (params.agentE2e
        ? `Print the selected ${params.channelLabel} scenario ids and exit`
        : undefined),
    normalizeInactiveSelectionOptions: true,
    outputDirHelp: `${params.channelLabel} QA artifact directory`,
    scenarioHelp: `Run only the named ${params.channelLabel} QA scenario (repeatable)`,
    sutAccountHelp: `Temporary ${params.channelLabel} account id inside the QA gateway config`,
    async run(options) {
      const runtime = await loadLiveTransportQaSuiteRuntime();
      await runtime.runStandardLiveTransportQaSuiteCommand({
        channelId: params.channelId,
        options,
      });
    },
  });
}
