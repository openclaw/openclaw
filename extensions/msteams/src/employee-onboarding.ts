// Msteams plugin module owns self-service employee onboarding decisions.
import { createHash } from "node:crypto";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "../runtime-api.js";

export type MSTeamsEmployeeOnboardingRequestStatus =
  | "pending"
  | "provisioned"
  | "linked"
  | "failed"
  | "rolled_back";

export type MSTeamsEmployeeOnboardingTerminalStatus = Exclude<
  MSTeamsEmployeeOnboardingRequestStatus,
  "pending"
>;

export type MSTeamsEmployeeOnboardingTransitionEvidence = {
  operator: "employee-onboarding-admin";
  requestId: string;
  peerHash: string;
  runnerImage?: string;
  agentIdHash?: string;
  stackNameHash?: string;
  routeProofHash?: string;
  serviceProofHash?: string;
  rollbackProofHash?: string;
};

export type MSTeamsEmployeeOnboardingRequest = {
  id: string;
  channel: "msteams";
  accountId: string;
  peerKind: "direct";
  peerHash: string;
  conversationHash: string;
  protectedRoute: {
    peerId: string;
    conversationId: string;
  };
  senderName?: string;
  status: MSTeamsEmployeeOnboardingRequestStatus;
  requestedAt: string;
  reason: "missing-direct-peer-assignment";
  transitionedAt?: string;
  transitionReason?: string;
  transitionEvidence?: MSTeamsEmployeeOnboardingTransitionEvidence;
  provisionedAgentId?: string;
  failureCode?: string;
};

export type MSTeamsEmployeeOnboardingTransitionRequest = {
  status: MSTeamsEmployeeOnboardingTerminalStatus;
  transitionedAt?: string;
  transitionReason?: string;
  transitionEvidence: MSTeamsEmployeeOnboardingTransitionEvidence;
  failureCode?: string;
};

export type MSTeamsEmployeeOnboardingTransitionResult =
  | {
      status: "transitioned" | "idempotent";
      request: MSTeamsEmployeeOnboardingRequest;
      sideEffects: ["employee-onboarding-request-transition"];
    }
  | {
      status: "blocked";
      reason: "missing-request" | "request-not-pending" | "conflicting-transition";
      message: string;
      request?: MSTeamsEmployeeOnboardingRequest;
      sideEffects: [];
    };

export type MSTeamsEmployeeOnboardingRequestStore = {
  upsertRequest: (
    request: MSTeamsEmployeeOnboardingRequest,
  ) => Promise<{ request: MSTeamsEmployeeOnboardingRequest; created: boolean }>;
  getRequest?: (requestId: string) => Promise<MSTeamsEmployeeOnboardingRequest | null>;
  listRequests?: () => Promise<MSTeamsEmployeeOnboardingRequest[]>;
  transitionRequest?: (
    requestId: string,
    transition: MSTeamsEmployeeOnboardingTransitionRequest,
  ) => Promise<MSTeamsEmployeeOnboardingTransitionResult>;
};

export type MSTeamsEmployeeOnboardingDecision =
  | {
      kind: "route-existing-assignment";
      agentId: string;
    }
  | {
      kind: "pending-onboarding";
      request: MSTeamsEmployeeOnboardingRequest;
    }
  | {
      kind: "pass-through";
      reason: "not-direct-message" | "disabled";
    };

export type MSTeamsEmployeeOnboardingDecisionTrace = {
  decision: MSTeamsEmployeeOnboardingDecision["kind"];
  routeMatchedBy: ResolvedAgentRoute["matchedBy"];
  routeAgentId: string;
  routeAccountId: string;
  peerHash?: string;
  conversationHash?: string;
  requestId?: string;
  requestStatus?: MSTeamsEmployeeOnboardingRequestStatus;
  requestCreated?: boolean;
  terminalStatusGuard?: boolean;
};

type SelfServiceOnboardingConfig = {
  enabled?: boolean;
  acknowledgementText?: string;
  failureAcknowledgementText?: string;
};

export const DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_ACK =
  "I found your Teams profile, but no employee agent is assigned yet. I created an onboarding request for review.";
export const DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_FAILURE_ACK =
  "I found your Teams profile, but I could not record the onboarding request. An administrator has been alerted.";

function getMSTeamsEmployeeSelfServiceConfig(
  cfg: OpenClawConfig,
): SelfServiceOnboardingConfig | undefined {
  return (
    cfg.channels?.msteams as unknown as
      | { employeeSelfServiceOnboarding?: SelfServiceOnboardingConfig }
      | undefined
  )?.employeeSelfServiceOnboarding;
}

export function isMSTeamsEmployeeSelfServiceOnboardingEnabled(cfg: OpenClawConfig): boolean {
  return getMSTeamsEmployeeSelfServiceConfig(cfg)?.enabled === true;
}

export function resolveMSTeamsEmployeeOnboardingAcknowledgement(cfg: OpenClawConfig): string {
  const configured = getMSTeamsEmployeeSelfServiceConfig(cfg)?.acknowledgementText?.trim();
  return configured || DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_ACK;
}

export function resolveMSTeamsEmployeeOnboardingFailureAcknowledgement(
  cfg: OpenClawConfig,
): string {
  const configured = getMSTeamsEmployeeSelfServiceConfig(cfg)?.failureAcknowledgementText?.trim();
  return configured || DEFAULT_MSTEAMS_EMPLOYEE_ONBOARDING_FAILURE_ACK;
}

export function redactMSTeamsEmployeeOnboardingRequest(
  request: MSTeamsEmployeeOnboardingRequest,
): Omit<MSTeamsEmployeeOnboardingRequest, "protectedRoute" | "transitionReason"> {
  const {
    protectedRoute: _protectedRoute,
    transitionReason: _transitionReason,
    ...redacted
  } = request;
  return redacted;
}

export function createMSTeamsEmployeeOnboardingDecisionTrace(params: {
  decision: MSTeamsEmployeeOnboardingDecision;
  route: Pick<ResolvedAgentRoute, "agentId" | "accountId" | "matchedBy">;
  request?: MSTeamsEmployeeOnboardingRequest;
  requestCreated?: boolean;
  terminalStatusGuard?: boolean;
}): MSTeamsEmployeeOnboardingDecisionTrace {
  const request =
    params.request ??
    (params.decision.kind === "pending-onboarding" ? params.decision.request : undefined);
  return {
    decision: params.decision.kind,
    routeMatchedBy: params.route.matchedBy,
    routeAgentId: params.route.agentId,
    routeAccountId: params.route.accountId,
    ...(request
      ? {
          peerHash: request.peerHash,
          conversationHash: request.conversationHash,
          requestId: request.id,
          requestStatus: request.status,
        }
      : {}),
    ...(params.requestCreated === undefined ? {} : { requestCreated: params.requestCreated }),
    ...(params.terminalStatusGuard === undefined
      ? {}
      : { terminalStatusGuard: params.terminalStatusGuard }),
  };
}

function hashRouteIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createMSTeamsEmployeeOnboardingRequest(params: {
  accountId: string;
  senderId: string;
  senderName?: string;
  conversationId: string;
  now?: Date;
}): MSTeamsEmployeeOnboardingRequest {
  const requestedAt = (params.now ?? new Date()).toISOString();
  const peerHash = hashRouteIdentifier(`msteams:${params.accountId}:direct:${params.senderId}`);
  return {
    id: `msteams-employee-onboarding-${peerHash}`,
    channel: "msteams",
    accountId: params.accountId,
    peerKind: "direct",
    peerHash,
    conversationHash: hashRouteIdentifier(
      `msteams:${params.accountId}:conversation:${params.conversationId}`,
    ),
    protectedRoute: {
      peerId: params.senderId,
      conversationId: params.conversationId,
    },
    ...(params.senderName?.trim() ? { senderName: params.senderName.trim() } : {}),
    status: "pending",
    requestedAt,
    reason: "missing-direct-peer-assignment",
  };
}

export function resolveMSTeamsEmployeeOnboardingDecision(params: {
  cfg: OpenClawConfig;
  isDirectMessage: boolean;
  route: Pick<ResolvedAgentRoute, "agentId" | "accountId" | "matchedBy">;
  senderId: string;
  senderName?: string;
  conversationId: string;
  now?: Date;
}): MSTeamsEmployeeOnboardingDecision {
  if (!params.isDirectMessage) {
    return { kind: "pass-through", reason: "not-direct-message" };
  }
  if (!isMSTeamsEmployeeSelfServiceOnboardingEnabled(params.cfg)) {
    return { kind: "pass-through", reason: "disabled" };
  }
  if (params.route.matchedBy === "binding.peer") {
    return {
      kind: "route-existing-assignment",
      agentId: params.route.agentId,
    };
  }
  return {
    kind: "pending-onboarding",
    request: createMSTeamsEmployeeOnboardingRequest({
      accountId: params.route.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      conversationId: params.conversationId,
      now: params.now,
    }),
  };
}
