import { a as listDevicePairing } from "../../device-bootstrap-CDEAV7q3.js";
//#region extensions/device-pair/pair-command-approve.d.ts
type PendingPairingEntry = Awaited<ReturnType<typeof listDevicePairing>>["pending"][number];
declare function selectPendingApprovalRequest(params: {
  pending: PendingPairingEntry[];
  requested?: string;
}): {
  pending?: PendingPairingEntry;
  reply?: {
    text: string;
  };
};
declare function approvePendingPairingRequest(params: {
  requestId: string;
  callerScopes?: readonly string[];
}): Promise<{
  text: string;
}>;
//#endregion
export { approvePendingPairingRequest, selectPendingApprovalRequest };