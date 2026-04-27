import { formatBonjourError } from "./errors.js";

const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
const CIAO_INTERFACE_ASSERTION_MESSAGE_RE =
  /REACHED ILLEGAL STATE!?\s+IPV4 ADDRESS CHANGE FROM (?:DEFINED TO UNDEFINED|UNDEFINED TO DEFINED)!?/u;
const CIAO_NETMASK_ASSERTION_MESSAGE_RE =
  /IP ADDRESS VERSION MUST MATCH\.\s+NETMASK CANNOT HAVE A VERSION DIFFERENT FROM THE ADDRESS!?/u;

export type CiaoProcessErrorClassification =
  | { kind: "cancellation"; formatted: string }
  | { kind: "interface-assertion"; formatted: string }
  | { kind: "netmask-assertion"; formatted: string };

export function classifyCiaoProcessError(reason: unknown): CiaoProcessErrorClassification | null {
  const formatted = formatBonjourError(reason);
  const message = formatted.toUpperCase();
  if (CIAO_CANCELLATION_MESSAGE_RE.test(message)) {
    return { kind: "cancellation", formatted };
  }
  if (CIAO_INTERFACE_ASSERTION_MESSAGE_RE.test(message)) {
    return { kind: "interface-assertion", formatted };
  }
  if (CIAO_NETMASK_ASSERTION_MESSAGE_RE.test(message)) {
    return { kind: "netmask-assertion", formatted };
  }
  return null;
}

export const classifyCiaoUnhandledRejection = classifyCiaoProcessError;

export function ignoreCiaoUnhandledRejection(reason: unknown): boolean {
  return classifyCiaoProcessError(reason) !== null;
}
