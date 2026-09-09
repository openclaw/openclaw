import { createHash } from "node:crypto";
import type { ResolvedAgentRoute } from "../routing/resolve-route.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

type ProviderAuthEnrollmentDesignInput = {
  agentId: string;
  provider?: string;
  profileId: string;
  secureEntrySurface: string;
};

export type ProviderAuthEnrollmentDesign = {
  agentId: string;
  provider: string;
  profileIdHash: string;
  secureEntrySurface: string;
  steps: readonly string[];
  chatCredentialCollectionAllowed: false;
  valueExposureAllowed: false;
};

export type ProviderAuthRuntimeInjectionProof = {
  provider: string;
  profileIdHash?: string;
  sourceClass: "profile" | "env" | "config" | "managed-secret-ref" | "runtime-auth" | "missing";
  mode: ResolvedProviderAuth["mode"];
  credentialPresent: boolean;
  valueExposed: false;
};

export type TeamsSmokeProofTrace = {
  source: "msteams.inbound.dispatch";
  ingressCorrelationHash: string;
  handlerDecisionTrace: "redacted";
  matchedBy: ResolvedAgentRoute["matchedBy"];
  routeAgentId: string;
  sessionKeyHash: string;
  messageIdHash?: string;
  conversationHash?: string;
  employeeIntakeSessionVisible: boolean;
  rawPeerExposed: false;
};

function stableHash(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function classifyAuthSource(source: string): ProviderAuthRuntimeInjectionProof["sourceClass"] {
  const normalized = source.trim().toLowerCase();
  if (!normalized) {
    return "missing";
  }
  if (normalized.startsWith("profile:")) {
    return "profile";
  }
  if (normalized.includes("runtime auth")) {
    return "runtime-auth";
  }
  if (normalized.includes("secretref") || normalized.includes("secret ref")) {
    return "managed-secret-ref";
  }
  if (normalized.includes("env") || /^[A-Z0-9_]+$/.test(source.trim())) {
    return "env";
  }
  return "config";
}

export function buildEmployeeOpenAIAuthEnrollmentDesign(
  input: ProviderAuthEnrollmentDesignInput,
): ProviderAuthEnrollmentDesign {
  const provider = input.provider?.trim() || "openai";
  return {
    agentId: input.agentId,
    provider,
    profileIdHash: stableHash(input.profileId) ?? "missing",
    secureEntrySurface: input.secureEntrySurface,
    chatCredentialCollectionAllowed: false,
    valueExposureAllowed: false,
    steps: [
      "Guide the employee to a host-owned secure credential-entry surface.",
      "Bind the resulting provider-auth profile to the employee agent by profile reference only.",
      "Record only profile id hash, source class, mode, and boolean availability in diagnostics.",
      "Fail closed before provider egress when the selected profile or runtime source is unavailable.",
    ],
  };
}

export function summarizeProviderAuthRuntimeInjection(
  auth: ResolvedProviderAuth,
): ProviderAuthRuntimeInjectionProof {
  const profileIdHash = stableHash(auth.profileId);
  return {
    provider: auth.profileId?.split(":")[0] ?? "unknown",
    ...(profileIdHash ? { profileIdHash } : {}),
    sourceClass: classifyAuthSource(auth.source),
    mode: auth.mode,
    credentialPresent: Boolean(auth.apiKey?.trim()),
    valueExposed: false,
  };
}

export function createTeamsSmokeProofTrace(input: {
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  route: Pick<ResolvedAgentRoute, "agentId" | "matchedBy" | "sessionKey">;
  employeeIntakeSessionVisible?: boolean;
}): TeamsSmokeProofTrace {
  const ingressCorrelationHash =
    stableHash(
      [input.accountId, input.conversationId, input.messageId].filter(Boolean).join(":"),
    ) ?? "missing";
  const messageIdHash = stableHash(input.messageId);
  const conversationHash = stableHash(input.conversationId);
  return {
    source: "msteams.inbound.dispatch",
    ingressCorrelationHash,
    handlerDecisionTrace: "redacted",
    matchedBy: input.route.matchedBy,
    routeAgentId: input.route.agentId,
    sessionKeyHash: stableHash(input.route.sessionKey) ?? "missing",
    ...(messageIdHash ? { messageIdHash } : {}),
    ...(conversationHash ? { conversationHash } : {}),
    employeeIntakeSessionVisible: input.employeeIntakeSessionVisible === true,
    rawPeerExposed: false,
  };
}
