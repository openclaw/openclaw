import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";

export type QaTransportFactoryMatchContext = {
  channelId: string;
  driver: string;
};

export type QaTransportAdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]> & {
  supportsModuleFlowsFor?: (context: QaTransportFactoryMatchContext) => boolean;
  prepareSelectedScenarios?: (scenarioIds: readonly string[]) => Promise<void>;
};
