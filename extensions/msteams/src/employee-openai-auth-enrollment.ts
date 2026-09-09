// Teams-safe employee OpenAI auth enrollment link lifecycle.
import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";

export const MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD = "chatgpt-login";
export const MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER = "openai";
export const MSTEAMS_OPENAI_AUTH_ENROLLMENT_TTL_MS = 15 * 60_000;

export type MSTeamsEmployeeOpenAIAuthPendingMapping = {
  requestId: string;
  agentId: string;
  employeeHash: string;
  peerHash?: string;
  accountId: string;
  status: "pending";
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentRecord = {
  id: string;
  requestId: string;
  agentId: string;
  employeeHash: string;
  accountId: string;
  provider: typeof MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER;
  method: typeof MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD;
  linkTokenHash: string;
  oauthStateHash: string;
  status: "pending" | "started" | "completed" | "failed";
  createdAt: string;
  expiresAt: string;
  startedAt?: string;
  completedAt?: string;
  failureCode?: MSTeamsEmployeeOpenAIAuthEnrollmentFailureCode;
  profileIdHash?: string;
  authOrderPresent?: boolean;
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentFailureCode =
  | "expired-link"
  | "reused-link"
  | "wrong-employee"
  | "wrong-agent"
  | "missing-pending-request"
  | "missing-state"
  | "callback-mismatch"
  | "provider-error"
  | "partial-bind-rolled-back";

export type MSTeamsEmployeeOpenAIAuthEnrollmentProof = {
  enrollmentIdHash?: string;
  requestIdHash?: string;
  agentId: string;
  employeeHash: string;
  provider: typeof MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER;
  method: typeof MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD;
  status: "pending" | "started" | "completed" | "failed" | "blocked";
  failureCode?: MSTeamsEmployeeOpenAIAuthEnrollmentFailureCode;
  createdAt?: string;
  expiresAt?: string;
  completedAt?: string;
  profileIdHash?: string;
  profilePresent?: boolean;
  authOrderPresent?: boolean;
  valueExposure: false;
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentStore = {
  getPendingMapping: (requestId: string) => Promise<MSTeamsEmployeeOpenAIAuthPendingMapping | null>;
  saveEnrollment: (record: MSTeamsEmployeeOpenAIAuthEnrollmentRecord) => Promise<void>;
  getEnrollmentByTokenHash: (
    linkTokenHash: string,
  ) => Promise<MSTeamsEmployeeOpenAIAuthEnrollmentRecord | null>;
  getEnrollmentByStateHash: (
    oauthStateHash: string,
  ) => Promise<MSTeamsEmployeeOpenAIAuthEnrollmentRecord | null>;
  updateEnrollment: (record: MSTeamsEmployeeOpenAIAuthEnrollmentRecord) => Promise<void>;
  persistOAuthProfile: (params: {
    agentId: string;
    profileId: string;
    credential: OAuthCredential;
  }) => Promise<void>;
  setAuthOrder: (params: {
    agentId: string;
    provider: "openai";
    profileId: string;
  }) => Promise<void>;
  removeOAuthProfile: (params: { agentId: string; profileId: string }) => Promise<void>;
};

export type MSTeamsEmployeeOpenAIAuthProvider = {
  createAuthorizationUrl: (params: {
    provider: "openai";
    method: typeof MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD;
    state: string;
    agentId: string;
    requestId: string;
  }) => Promise<string>;
  completeCallback: (params: {
    provider: "openai";
    method: typeof MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD;
    state: string;
    callbackCode: string;
    agentId: string;
    requestId: string;
  }) => Promise<{
    profileId: string;
    credential: OAuthCredential;
  }>;
};

export type MSTeamsEmployeeOpenAIAuthEnrollmentResult =
  | {
      status: "created";
      enrollmentLink: string;
      message: string;
      proof: MSTeamsEmployeeOpenAIAuthEnrollmentProof;
    }
  | { status: "blocked"; proof: MSTeamsEmployeeOpenAIAuthEnrollmentProof };

export type MSTeamsEmployeeOpenAIAuthStartResult =
  | {
      status: "redirect";
      authorizationUrl: string;
      proof: MSTeamsEmployeeOpenAIAuthEnrollmentProof;
    }
  | { status: "blocked"; proof: MSTeamsEmployeeOpenAIAuthEnrollmentProof };

export type MSTeamsEmployeeOpenAIAuthCallbackResult =
  | { status: "completed"; proof: MSTeamsEmployeeOpenAIAuthEnrollmentProof }
  | { status: "blocked"; proof: MSTeamsEmployeeOpenAIAuthEnrollmentProof };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, 24);
}

function createOpaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(record: MSTeamsEmployeeOpenAIAuthEnrollmentRecord, now?: Date): boolean {
  return parseTimestampMs(record.expiresAt) <= (now ?? new Date()).getTime();
}

function failProof(params: {
  mapping?: MSTeamsEmployeeOpenAIAuthPendingMapping | null;
  record?: MSTeamsEmployeeOpenAIAuthEnrollmentRecord | null;
  agentId: string;
  employeeHash: string;
  failureCode: MSTeamsEmployeeOpenAIAuthEnrollmentFailureCode;
}): MSTeamsEmployeeOpenAIAuthEnrollmentProof {
  return {
    enrollmentIdHash: params.record ? shortHash(params.record.id) : undefined,
    requestIdHash:
      params.record?.requestId || params.mapping?.requestId
        ? shortHash(params.record?.requestId ?? params.mapping!.requestId)
        : undefined,
    agentId: params.record?.agentId ?? params.mapping?.agentId ?? params.agentId,
    employeeHash:
      params.record?.employeeHash ?? params.mapping?.employeeHash ?? params.employeeHash,
    provider: MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER,
    method: MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD,
    status: "blocked",
    failureCode: params.failureCode,
    valueExposure: false,
  };
}

function recordProof(
  record: MSTeamsEmployeeOpenAIAuthEnrollmentRecord,
): MSTeamsEmployeeOpenAIAuthEnrollmentProof {
  return {
    enrollmentIdHash: shortHash(record.id),
    requestIdHash: shortHash(record.requestId),
    agentId: record.agentId,
    employeeHash: record.employeeHash,
    provider: record.provider,
    method: record.method,
    status: record.status,
    failureCode: record.failureCode,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    completedAt: record.completedAt,
    profileIdHash: record.profileIdHash,
    profilePresent: record.profileIdHash !== undefined,
    authOrderPresent: record.authOrderPresent,
    valueExposure: false,
  };
}

function validateMapping(params: {
  mapping: MSTeamsEmployeeOpenAIAuthPendingMapping | null;
  requestId: string;
  agentId: string;
  employeeHash: string;
}):
  | { ok: true; mapping: MSTeamsEmployeeOpenAIAuthPendingMapping }
  | { ok: false; failureCode: MSTeamsEmployeeOpenAIAuthEnrollmentFailureCode } {
  if (!params.mapping) {
    return { ok: false, failureCode: "missing-pending-request" };
  }
  if (params.mapping.agentId !== params.agentId) {
    return { ok: false, failureCode: "wrong-agent" };
  }
  if (params.mapping.employeeHash !== params.employeeHash) {
    return { ok: false, failureCode: "wrong-employee" };
  }
  return { ok: true, mapping: params.mapping };
}

export async function createMSTeamsEmployeeOpenAIAuthEnrollmentLink(params: {
  store: MSTeamsEmployeeOpenAIAuthEnrollmentStore;
  requestId: string;
  agentId: string;
  employeeHash: string;
  baseUrl: string;
  now?: Date;
  ttlMs?: number;
  tokenFactory?: () => string;
  stateFactory?: () => string;
}): Promise<MSTeamsEmployeeOpenAIAuthEnrollmentResult> {
  const mapping = await params.store.getPendingMapping(params.requestId);
  const mappingResult = validateMapping({
    mapping,
    requestId: params.requestId,
    agentId: params.agentId,
    employeeHash: params.employeeHash,
  });
  if (!mappingResult.ok) {
    return {
      status: "blocked",
      proof: failProof({
        mapping,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: mappingResult.failureCode,
      }),
    };
  }

  const token = params.tokenFactory?.() ?? createOpaqueValue();
  const state = params.stateFactory?.() ?? createOpaqueValue();
  const createdAt = nowIso(params.now);
  const expiresAt = new Date(
    (params.now ?? new Date()).getTime() + (params.ttlMs ?? MSTEAMS_OPENAI_AUTH_ENROLLMENT_TTL_MS),
  ).toISOString();
  const link = new URL(`/auth/enroll/openai/${encodeURIComponent(token)}`, params.baseUrl);
  const enrollment: MSTeamsEmployeeOpenAIAuthEnrollmentRecord = {
    id: `msteams-openai-auth-enrollment-${shortHash(`${params.requestId}:${token}`)}`,
    requestId: params.requestId,
    agentId: params.agentId,
    employeeHash: params.employeeHash,
    accountId: mappingResult.mapping.accountId,
    provider: MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER,
    method: MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD,
    linkTokenHash: sha256Hex(token),
    oauthStateHash: sha256Hex(state),
    status: "pending",
    createdAt,
    expiresAt,
  };
  await params.store.saveEnrollment(enrollment);
  return {
    status: "created",
    enrollmentLink: link.toString(),
    message: [
      "Your OpenAI sign-in is ready.",
      "Use this one-time OpenClaw enrollment link to sign in directly with OpenAI in your browser.",
      "Do not paste passwords, API keys, codes, or tokens into Teams.",
      link.toString(),
    ].join("\n"),
    proof: recordProof(enrollment),
  };
}

export async function startMSTeamsEmployeeOpenAIAuthEnrollment(params: {
  store: MSTeamsEmployeeOpenAIAuthEnrollmentStore;
  provider: MSTeamsEmployeeOpenAIAuthProvider;
  linkToken: string;
  agentId: string;
  employeeHash: string;
  now?: Date;
}): Promise<MSTeamsEmployeeOpenAIAuthStartResult> {
  const tokenHash = sha256Hex(params.linkToken);
  const record = await params.store.getEnrollmentByTokenHash(tokenHash);
  if (!record) {
    return {
      status: "blocked",
      proof: failProof({
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "missing-pending-request",
      }),
    };
  }
  if (record.agentId !== params.agentId) {
    return {
      status: "blocked",
      proof: failProof({
        record,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "wrong-agent",
      }),
    };
  }
  if (record.employeeHash !== params.employeeHash) {
    return {
      status: "blocked",
      proof: failProof({
        record,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "wrong-employee",
      }),
    };
  }
  if (record.status !== "pending") {
    return {
      status: "blocked",
      proof: failProof({
        record,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "reused-link",
      }),
    };
  }
  if (isExpired(record, params.now)) {
    const failed = { ...record, status: "failed" as const, failureCode: "expired-link" as const };
    await params.store.updateEnrollment(failed);
    return { status: "blocked", proof: recordProof(failed) };
  }

  const state = createOpaqueValue();
  const started = {
    ...record,
    oauthStateHash: sha256Hex(state),
    status: "started" as const,
    startedAt: nowIso(params.now),
  };
  await params.store.updateEnrollment(started);
  try {
    const authorizationUrl = await params.provider.createAuthorizationUrl({
      provider: MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER,
      method: MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD,
      state,
      agentId: record.agentId,
      requestId: record.requestId,
    });
    return { status: "redirect", authorizationUrl, proof: recordProof(started) };
  } catch {
    const failed = {
      ...started,
      status: "failed" as const,
      failureCode: "provider-error" as const,
    };
    await params.store.updateEnrollment(failed);
    return { status: "blocked", proof: recordProof(failed) };
  }
}

export async function completeMSTeamsEmployeeOpenAIAuthEnrollment(params: {
  store: MSTeamsEmployeeOpenAIAuthEnrollmentStore;
  provider: MSTeamsEmployeeOpenAIAuthProvider;
  state: string | undefined;
  callbackCode?: string;
  providerError?: string;
  agentId: string;
  employeeHash: string;
  now?: Date;
}): Promise<MSTeamsEmployeeOpenAIAuthCallbackResult> {
  if (!params.state) {
    return {
      status: "blocked",
      proof: failProof({
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "missing-state",
      }),
    };
  }
  const record = await params.store.getEnrollmentByStateHash(sha256Hex(params.state));
  if (!record || record.status !== "started") {
    return {
      status: "blocked",
      proof: failProof({
        record,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "callback-mismatch",
      }),
    };
  }
  if (record.agentId !== params.agentId) {
    return {
      status: "blocked",
      proof: failProof({
        record,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "wrong-agent",
      }),
    };
  }
  if (record.employeeHash !== params.employeeHash) {
    return {
      status: "blocked",
      proof: failProof({
        record,
        agentId: params.agentId,
        employeeHash: params.employeeHash,
        failureCode: "wrong-employee",
      }),
    };
  }
  if (params.providerError || !params.callbackCode) {
    const failed = { ...record, status: "failed" as const, failureCode: "provider-error" as const };
    await params.store.updateEnrollment(failed);
    return { status: "blocked", proof: recordProof(failed) };
  }

  const completedAt = nowIso(params.now);
  let persistedProfileId: string | undefined;
  try {
    const profile = await params.provider.completeCallback({
      provider: MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER,
      method: MSTEAMS_OPENAI_AUTH_ENROLLMENT_METHOD,
      state: params.state,
      callbackCode: params.callbackCode,
      agentId: record.agentId,
      requestId: record.requestId,
    });
    if (profile.credential.provider !== MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER) {
      throw new Error("Provider callback returned a non-OpenAI credential.");
    }
    await params.store.persistOAuthProfile({
      agentId: record.agentId,
      profileId: profile.profileId,
      credential: profile.credential,
    });
    persistedProfileId = profile.profileId;
    await params.store.setAuthOrder({
      agentId: record.agentId,
      provider: MSTEAMS_OPENAI_AUTH_ENROLLMENT_PROVIDER,
      profileId: profile.profileId,
    });
    const completed = {
      ...record,
      status: "completed" as const,
      completedAt,
      profileIdHash: shortHash(profile.profileId),
      authOrderPresent: true,
    };
    await params.store.updateEnrollment(completed);
    return { status: "completed", proof: recordProof(completed) };
  } catch {
    if (persistedProfileId) {
      await params.store
        .removeOAuthProfile({ agentId: record.agentId, profileId: persistedProfileId })
        .catch(() => {});
    }
    const failed = {
      ...record,
      status: "failed" as const,
      completedAt,
      failureCode: "partial-bind-rolled-back" as const,
      authOrderPresent: false,
    };
    await params.store.updateEnrollment(failed);
    return { status: "blocked", proof: recordProof(failed) };
  }
}
