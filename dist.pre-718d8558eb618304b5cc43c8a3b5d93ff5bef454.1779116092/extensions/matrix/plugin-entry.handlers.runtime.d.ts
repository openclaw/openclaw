import { r as GatewayRequestHandlerOptions } from "../../types-Hf3aPs3a.js";
//#region extensions/matrix/src/plugin-entry.runtime.d.ts
declare function handleVerifyRecoveryKey({
  params,
  respond
}: GatewayRequestHandlerOptions): Promise<void>;
declare function handleVerificationBootstrap({
  params,
  respond
}: GatewayRequestHandlerOptions): Promise<void>;
declare function handleVerificationStatus({
  params,
  respond
}: GatewayRequestHandlerOptions): Promise<void>;
//#endregion
export { handleVerificationBootstrap, handleVerificationStatus, handleVerifyRecoveryKey };