//#region extensions/signal/src/uuid.d.ts
declare function looksLikeUuid(value: string): boolean;
//#endregion
//#region extensions/signal/src/identity.d.ts
type SignalSender = {
  kind: "phone";
  raw: string;
  e164: string;
} | {
  kind: "uuid";
  raw: string;
};
declare function resolveSignalSender(params: {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
}): SignalSender | null;
declare function formatSignalSenderId(sender: SignalSender): string;
declare function formatSignalSenderDisplay(sender: SignalSender): string;
declare function formatSignalPairingIdLine(sender: SignalSender): string;
declare function resolveSignalRecipient(sender: SignalSender): string;
declare function resolveSignalPeerId(sender: SignalSender): string;
declare function normalizeSignalAllowRecipient(entry: string): string | undefined;
declare function isSignalSenderAllowed(sender: SignalSender, allowFrom: string[]): boolean;
//#endregion
export { isSignalSenderAllowed as a, resolveSignalRecipient as c, formatSignalSenderId as i, resolveSignalSender as l, formatSignalPairingIdLine as n, normalizeSignalAllowRecipient as o, formatSignalSenderDisplay as r, resolveSignalPeerId as s, SignalSender as t, looksLikeUuid as u };