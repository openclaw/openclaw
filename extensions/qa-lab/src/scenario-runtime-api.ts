import type { QaTransportAdapter } from "./qa-transport.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaScenarioTransport = Pick<
  QaTransportAdapter,
  | "reset"
  | "sendInbound"
  | "sendNativeCommand"
  | "state"
  | "waitForNoOutbound"
  | "waitForOutbound"
  | "waitForCondition"
>;

export type QaScenarioRuntimeEnv<
  TLab = unknown,
  TTransport extends QaScenarioTransport = QaScenarioTransport,
> = {
  lab: TLab;
  transport: TTransport;
};

type QaScenarioRuntimeApiDeps = {
  waitForTransportReady: (...args: never[]) => unknown;
};

type QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
};

export function createQaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeApiDeps,
>(params: {
  env: TEnv;
  scenario: QaSeedScenarioWithSource;
  deps: TDeps;
  constants: QaScenarioRuntimeConstants;
}) {
  const transport = params.env.transport;
  const transportState = transport.state;
  const resetTransportState = async () => {
    await transport.reset();
  };

  return {
    ...params.deps,
    env: params.env,
    lab: params.env.lab,
    transport,
    state: transportState,
    scenario: params.scenario,
    config: params.scenario.execution.config ?? {},
    waitForCondition: transport.waitForCondition,
    waitForChannelReady: params.deps.waitForTransportReady,
    waitForQaChannelReady: params.deps.waitForTransportReady,
    imageUnderstandingPngBase64: params.constants.imageUnderstandingPngBase64,
    imageUnderstandingLargePngBase64: params.constants.imageUnderstandingLargePngBase64,
    imageUnderstandingValidPngBase64: params.constants.imageUnderstandingValidPngBase64,
    getTransportSnapshot: transportState.getSnapshot.bind(transportState),
    resetTransport: resetTransportState,
    injectInboundMessage: transport.sendInbound.bind(transport),
    injectOutboundMessage: transportState.addOutboundMessage.bind(transportState),
    readTransportMessage: transportState.readMessage.bind(transportState),
    resetBus: resetTransportState,
    reset: resetTransportState,
  };
}
