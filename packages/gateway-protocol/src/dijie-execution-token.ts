import crypto from "node:crypto";

export type DijieExecutionTokenPricing = {
  kind: "one_time_authorization";
  authorizationFeeCents: number;
  currency: string;
  platformFeeBps: number;
  developerReceivableCents: number;
};

export type DijieRoleTokenPricing = {
  inputTokenCentsPerMillion: number;
  outputTokenCentsPerMillion: number;
  currency: string;
  developerReceivableBps: number;
  platformFeeBps: number;
};

export type DijieExecutionTokenClaims = {
  iss: "dijie-cloud";
  typ: "dijie_execution";
  executionId: string;
  actorId: string;
  roleListingId: string;
  packageId: string;
  packageVersion: string;
  developerRef: string;
  listingOwnerRef: string;
  billingBeneficiaryRef: string;
  entitlementId: string;
  deviceId: string;
  workspaceRef: string;
  localGatewayId: string;
  scopes: string[];
  pricing: DijieExecutionTokenPricing;
  roleTokenPricing: DijieRoleTokenPricing;
  iat: number;
  exp: number;
};

export type DijieExecutionTokenVerificationResult =
  | {
      ok: true;
      claims: DijieExecutionTokenClaims;
    }
  | {
      ok: false;
      error: string;
    };

function parseJsonPart(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function normalizePem(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\n/g, "\n");
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isOneTimePricing(value: unknown): value is DijieExecutionTokenPricing {
  if (!isRecord(value) || value.kind !== "one_time_authorization") {
    return false;
  }

  return (
    Number.isInteger(value.authorizationFeeCents) &&
    Number(value.authorizationFeeCents) >= 0 &&
    isNonEmptyString(value.currency) &&
    Number.isInteger(value.platformFeeBps) &&
    Number(value.platformFeeBps) === 0 &&
    Number.isInteger(value.developerReceivableCents) &&
    Number(value.developerReceivableCents) === Number(value.authorizationFeeCents)
  );
}

function isRoleTokenPricing(value: unknown): value is DijieRoleTokenPricing {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Number.isInteger(value.inputTokenCentsPerMillion) &&
    Number(value.inputTokenCentsPerMillion) >= 0 &&
    Number.isInteger(value.outputTokenCentsPerMillion) &&
    Number(value.outputTokenCentsPerMillion) >= 0 &&
    isNonEmptyString(value.currency) &&
    Number.isInteger(value.developerReceivableBps) &&
    Number(value.developerReceivableBps) === 10000 &&
    Number.isInteger(value.platformFeeBps) &&
    Number(value.platformFeeBps) === 0
  );
}

function normalizeClaims(value: unknown): DijieExecutionTokenClaims | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.iss !== "dijie-cloud" ||
    value.typ !== "dijie_execution" ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.actorId) ||
    !isNonEmptyString(value.roleListingId) ||
    !isNonEmptyString(value.packageId) ||
    !isNonEmptyString(value.packageVersion) ||
    !isNonEmptyString(value.developerRef) ||
    !isNonEmptyString(value.listingOwnerRef) ||
    !isNonEmptyString(value.billingBeneficiaryRef) ||
    !isNonEmptyString(value.entitlementId) ||
    !isNonEmptyString(value.deviceId) ||
    !isNonEmptyString(value.workspaceRef) ||
    !isNonEmptyString(value.localGatewayId) ||
    !isStringArray(value.scopes) ||
    !isOneTimePricing(value.pricing) ||
    !isRoleTokenPricing(value.roleTokenPricing) ||
    !Number.isInteger(value.iat) ||
    !Number.isInteger(value.exp)
  ) {
    return undefined;
  }

  return {
    iss: "dijie-cloud",
    typ: "dijie_execution",
    executionId: value.executionId,
    actorId: value.actorId,
    roleListingId: value.roleListingId,
    packageId: value.packageId,
    packageVersion: value.packageVersion,
    developerRef: value.developerRef,
    listingOwnerRef: value.listingOwnerRef,
    billingBeneficiaryRef: value.billingBeneficiaryRef,
    entitlementId: value.entitlementId,
    deviceId: value.deviceId,
    workspaceRef: value.workspaceRef,
    localGatewayId: value.localGatewayId,
    scopes: value.scopes,
    pricing: value.pricing,
    roleTokenPricing: value.roleTokenPricing,
    iat: value.iat,
    exp: value.exp,
  };
}

export function verifyDijieExecutionToken(
  token: string,
  publicKeyPem: string | undefined,
  nowMs = Date.now(),
): DijieExecutionTokenVerificationResult {
  const normalizedPublicKey = normalizePem(publicKeyPem);
  if (!normalizedPublicKey) {
    return { ok: false, error: "Dijie execution token public key is required." };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "Invalid Dijie execution token format." };
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = parseJsonPart(parts[0]);
    payload = parseJsonPart(parts[1]);
  } catch {
    return { ok: false, error: "Invalid Dijie execution token JSON." };
  }

  if (
    !isRecord(header) ||
    header.alg !== "EdDSA" ||
    header.typ !== "JWT" ||
    header.kid !== "dijie-execution-token-v1"
  ) {
    return { ok: false, error: "Unsupported Dijie execution token header." };
  }

  let signatureIsValid = false;
  try {
    signatureIsValid = crypto.verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      normalizedPublicKey,
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    return { ok: false, error: "Invalid Dijie execution token public key." };
  }
  if (!signatureIsValid) {
    return { ok: false, error: "Invalid Dijie execution token signature." };
  }

  const claims = normalizeClaims(payload);
  if (!claims) {
    return { ok: false, error: "Invalid Dijie execution token claims." };
  }

  if (claims.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false, error: "Dijie execution token expired." };
  }

  return { ok: true, claims };
}
