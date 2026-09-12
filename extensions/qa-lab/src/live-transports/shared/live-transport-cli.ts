// Qa Lab plugin module implements live transport cli behavior.
import {
  createLiveTransportQaCliRegistration as createQaRunnerCliRegistration,
  type LiveTransportQaCommandOptions as QaRunnerCommandOptions,
  type LiveTransportQaCliRegistrationOptions as QaRunnerCliRegistrationOptions,
  type QaRunnerCliRegistration,
} from "openclaw/plugin-sdk/qa-runner-runtime";
import { parseQaCliPositiveIntegerOption } from "../../cli-options.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, formatQaProviderModeHelp } from "../../providers/index.js";
import type { QaTransportAdapterFactory } from "../../qa-transport-registry.js";

export type LiveTransportQaCommandOptions = QaRunnerCommandOptions & {
  concurrency?: number;
};

export type LiveTransportQaCliRegistration = Omit<QaRunnerCliRegistration, "adapterFactory"> & {
  adapterFactory?: QaTransportAdapterFactory;
};

type LiveTransportQaCliRegistrationOptions = Omit<
  QaRunnerCliRegistrationOptions,
  "adapterFactory" | "concurrency"
> & {
  adapterFactory?: QaTransportAdapterFactory;
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
  return createQaRunnerCliRegistration({
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
  });
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
  createAdapter: NonNullable<LiveTransportQaCliRegistrationOptions["adapterFactory"]>["create"];
  description: string;
}): LiveTransportQaCliRegistration {
  const adapterFactory = createLiveTransportQaAdapterFactory({
    id: params.channelId,
    supportsModuleFlows: true,
    create: params.createAdapter,
  });
  return createLiveTransportQaCliRegistration({
    commandName: params.channelId,
    adapterFactory,
    credentialOptions: {
      sourceDescription: `Credential source for ${params.channelLabel} QA: env or convex (default: env)`,
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: params.description,
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
