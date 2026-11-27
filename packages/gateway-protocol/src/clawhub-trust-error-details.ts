import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "./gateway-error-codes.js";
import { asProtocolRecord, isProtocolRecord } from "./protocol-value-normalization.js";

export const CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED = "CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED";

/** Structured ClawHub trust details carried in gateway error payloads. */
export const ClawHubTrustErrorCodes = {
  SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  DOWNLOAD_BLOCKED: "clawhub_download_blocked",
} as const;

type ClawHubTrustErrorCode = (typeof ClawHubTrustErrorCodes)[keyof typeof ClawHubTrustErrorCodes];

export type ClawHubTrustErrorDetails = {
  clawhubTrustCode?: ClawHubTrustErrorCode;
  version?: string;
  warning?: string;
};

export function isClawHubTrustErrorCode(value: unknown): value is ClawHubTrustErrorCode {
  return (
    value === ClawHubTrustErrorCodes.SECURITY_UNAVAILABLE ||
    value === ClawHubTrustErrorCodes.DOWNLOAD_BLOCKED
  );
}

export function buildClawHubTrustErrorDetails(params: {
  code?: ClawHubTrustErrorCode;
  version?: string;
  warning?: string;
}): ClawHubTrustErrorDetails | undefined {
  if (!params.code && !params.version && !params.warning) {
    return undefined;
  }
  return {
    ...(params.code ? { clawhubTrustCode: params.code } : {}),
    ...(params.version ? { version: params.version } : {}),
    ...(params.warning ? { warning: params.warning } : {}),
  };
}

export function readClawHubTrustErrorDetails(
  details: unknown,
): ClawHubTrustErrorDetails | undefined {
  if (!isProtocolRecord(details)) {
    return undefined;
  }
  return buildClawHubTrustErrorDetails({
    code: isClawHubTrustErrorCode(details.clawhubTrustCode) ? details.clawhubTrustCode : undefined,
    version: readNonBlankString(details.version),
    warning: readNonBlankString(details.warning),
  });
}

export type ClawHubRiskAcknowledgementRequiredErrorDetails = {
  code: typeof CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED;
  warning: string;
};

export function readClawHubRiskAcknowledgementRequiredError(
  error: unknown,
): ClawHubRiskAcknowledgementRequiredErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  const warning = typeof details?.warning === "string" ? details.warning.trim() : "";
  return record?.code === ErrorCodes.INVALID_REQUEST &&
    details?.code === CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED &&
    warning
    ? { code: CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED, warning }
    : null;
}
