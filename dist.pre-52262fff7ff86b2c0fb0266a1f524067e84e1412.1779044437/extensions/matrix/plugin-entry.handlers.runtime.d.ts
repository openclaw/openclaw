import { r as GatewayRequestHandlerOptions } from "../../types-Bfiga8Uc.js";
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