import { C as OpenClawPluginApi } from "../../types-UTp4ves_.js";
//#region extensions/matrix/src/matrix/subagent-hooks.d.ts
type MatrixSubagentSpawningEvent = {
  threadRequested: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
};
type MatrixSubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: string;
  accountId?: string;
  reason?: string;
  sendFarewell?: boolean;
};
type MatrixSubagentDeliveryTargetEvent = {
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  expectsCompletionMessage: boolean;
};
type MatrixDeliveryOrigin = {
  channel: "matrix";
  accountId: string;
  to: string;
  threadId?: string;
};
type SpawningResult = {
  status: "ok";
  threadBindingReady?: boolean;
  deliveryOrigin?: MatrixDeliveryOrigin;
} | {
  status: "error";
  error: string;
};
type DeliveryTargetResult = {
  origin: MatrixDeliveryOrigin;
};
declare function handleMatrixSubagentSpawning(api: OpenClawPluginApi, event: MatrixSubagentSpawningEvent): Promise<SpawningResult | undefined>;
declare function handleMatrixSubagentEnded(event: MatrixSubagentEndedEvent): Promise<void>;
declare function handleMatrixSubagentDeliveryTarget(event: MatrixSubagentDeliveryTargetEvent): DeliveryTargetResult | undefined;
//#endregion
//#region extensions/matrix/subagent-hooks-api.d.ts
declare function registerMatrixSubagentHooks(api: OpenClawPluginApi): void;
//#endregion
export { handleMatrixSubagentDeliveryTarget, handleMatrixSubagentEnded, handleMatrixSubagentSpawning, registerMatrixSubagentHooks };