import { t as PairingChannel } from "./pairing-store.types-C2l22gWY.js";

//#region src/pairing/pairing-messages.d.ts
declare function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string;
//#endregion
export { buildPairingReply as t };