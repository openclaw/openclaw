// Qa Lab API module exposes the plugin public contract.
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
  sleep: (ms?: number) => Promise<unknown>;
  waitForTransportReady: (...args: never[]) => unknown;
};

type QaScenarioRuntimeConstants = {
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
};

type QaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv = QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeApiDeps = QaScenarioRuntimeApiDeps,
> = TDeps & {
  env: TEnv;
  lab: TEnv["lab"];
  transport: TEnv["transport"];
  state: TEnv["transport"]["state"];
  scenario: QaSeedScenarioWithSource;
  config: Record<string, unknown>;
  waitForCondition: TEnv["transport"]["waitForCondition"];
  waitForChannelReady: TDeps["waitForTransportReady"];
  waitForQaChannelReady: TDeps["waitForTransportReady"];
  imageUnderstandingPngBase64: string;
  imageUnderstandingLargePngBase64: string;
  imageUnderstandingValidPngBase64: string;
  getTransportSnapshot: TEnv["transport"]["state"]["getSnapshot"];
  resetTransport: () => Promise<void>;
  injectInboundMessage: TEnv["transport"]["sendInbound"];
  injectOutboundMessage: TEnv["transport"]["state"]["addOutboundMessage"];
  readTransportMessage: TEnv["transport"]["state"]["readMessage"];
  resetBus: () => Promise<void>;
  reset: () => Promise<void>;
};

export function createQaScenarioRuntimeApi<
  TEnv extends QaScenarioRuntimeEnv,
  TDeps extends QaScenarioRuntimeApiDeps,
>(params: {
  env: TEnv;
  scenario: QaSeedScenarioWithSource;
  deps: TDeps;
  constants: QaScenarioRuntimeConstants;
}): QaScenarioRuntimeApi<TEnv, TDeps> {
  const transport = params.env.transport;
  const transportState = transport.state;
  const resetTransportState = async () => {
    await transport.reset();
    await params.deps.sleep(100);
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
