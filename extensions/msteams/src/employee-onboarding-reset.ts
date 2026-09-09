// Msteams plugin module renders reset plans for repeatable employee onboarding tests.
import { createHash } from "node:crypto";

export type MSTeamsEmployeeOnboardingResetProfile = {
  displayName: string;
  email: string;
  desiredSlug?: string;
};

export type MSTeamsEmployeeOnboardingResetPlan = {
  dryRun: true;
  status: "ready" | "blocked";
  reason?: "missing-employee-profile" | "missing-teams-peer";
  message?: string;
  target: {
    accountId: string;
    peerKind: "direct";
    peerHash?: string;
    conversationHash?: string;
    requestId?: string;
    employee: {
      displayName: string;
      email: string;
      slug: string;
    };
    protectedRoute?: {
      peerId: string;
      conversationId?: string;
    };
  };
  cleanup: {
    pairingRequest?: {
      namespace: "msteams-pairing-requests";
      key: string;
    };
    pendingRequest?: {
      namespace: "employee-onboarding-requests";
      key: string;
    };
    routeBinding?: {
      agentId: string;
      command: string;
    };
    stack?: {
      name: string;
      command: string;
    };
    service?: {
      name: string;
      inspectCommand: string;
    };
    secret?: {
      name: string;
      command: string;
    };
    auth?: {
      agentId: string;
      provider: "openai";
      profileGlob: string;
      orderKey: string;
    };
    paths: Array<{
      kind: "root" | "agent" | "config" | "state" | "workspace" | "shared" | "stack";
      path: string;
    }>;
  };
  validation: string[];
  approvalRequired: true;
  sideEffects: [];
};

export type RedactedMSTeamsEmployeeOnboardingResetPlan = Omit<
  MSTeamsEmployeeOnboardingResetPlan,
  "target" | "cleanup"
> & {
  target: Omit<MSTeamsEmployeeOnboardingResetPlan["target"], "protectedRoute"> & {
    protectedRoute?: {
      peerId: "[protected]";
      peerHash?: string;
      conversationId?: "[protected]";
      conversationHash?: string;
    };
  };
  cleanup: Omit<
    MSTeamsEmployeeOnboardingResetPlan["cleanup"],
    "routeBinding" | "pairingRequest"
  > & {
    pairingRequest?: {
      namespace: "msteams-pairing-requests";
      key: "<protected>";
    };
    routeBinding?: {
      agentId: string;
      command: string;
    };
  };
};

const DEFAULT_EMPLOYEE_AGENT_ROOT = "/srv/openclaw/data/employee-agents";
const DEFAULT_EMPLOYEE_STACK_ROOT = "/srv/openclaw/stacks";
const REQUEST_NAMESPACE = "employee-onboarding-requests" as const;

function normalizeSlug(input: string | undefined): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function slugFromProfile(profile: MSTeamsEmployeeOnboardingResetProfile): string {
  const desired = normalizeSlug(profile.desiredSlug);
  if (desired) {
    return desired;
  }
  const emailLocal = normalizeSlug(profile.email.split("@")[0]);
  if (emailLocal) {
    return emailLocal;
  }
  return normalizeSlug(profile.displayName);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function createBlockedPlan(params: {
  accountId: string;
  employee: MSTeamsEmployeeOnboardingResetProfile;
  reason: MSTeamsEmployeeOnboardingResetPlan["reason"];
  message: string;
}): MSTeamsEmployeeOnboardingResetPlan {
  return {
    dryRun: true,
    status: "blocked",
    reason: params.reason,
    message: params.message,
    target: {
      accountId: params.accountId,
      peerKind: "direct",
      employee: {
        displayName: params.employee.displayName.trim(),
        email: params.employee.email.trim(),
        slug: slugFromProfile(params.employee),
      },
    },
    cleanup: { paths: [] },
    validation: [],
    approvalRequired: true,
    sideEffects: [],
  };
}

export function createMSTeamsEmployeeOnboardingResetPlan(params: {
  accountId: string;
  senderId?: string;
  conversationId?: string;
  employee: MSTeamsEmployeeOnboardingResetProfile;
  roots?: {
    employeeAgentRoot?: string;
    stackRoot?: string;
  };
}): MSTeamsEmployeeOnboardingResetPlan {
  const slug = slugFromProfile(params.employee);
  if (!params.employee.displayName.trim() || !params.employee.email.trim() || !slug) {
    return createBlockedPlan({
      accountId: params.accountId,
      employee: params.employee,
      reason: "missing-employee-profile",
      message:
        "Employee display name, email/UPN, and resolvable slug are required for reset planning.",
    });
  }
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return createBlockedPlan({
      accountId: params.accountId,
      employee: params.employee,
      reason: "missing-teams-peer",
      message: "Teams direct peer id is required so reset cannot remove the wrong employee route.",
    });
  }

  const root = `${params.roots?.employeeAgentRoot ?? DEFAULT_EMPLOYEE_AGENT_ROOT}/${slug}`;
  const stackName = `employee-agent-${slug}`;
  const stackRoot = `${params.roots?.stackRoot ?? DEFAULT_EMPLOYEE_STACK_ROOT}/${stackName}`;
  const agentId = slug;
  const serviceName = stackName;
  const secretName = `employee_agent_${slug.replace(/-/gu, "_")}_token_v1`;
  const peerHash = shortHash(`msteams:${params.accountId}:direct:${senderId}`);
  const conversationHash = params.conversationId
    ? shortHash(`msteams:${params.accountId}:conversation:${params.conversationId}`)
    : undefined;
  const requestId = `msteams-employee-onboarding-${peerHash}`;
  const unbindRoute = `openclaw agents unbind --agent ${shellSingleQuote(
    agentId,
  )} --bind msteams:${shellSingleQuote(params.accountId)} --peer-kind direct --peer-id ${shellSingleQuote(
    senderId,
  )} --json`;

  return {
    dryRun: true,
    status: "ready",
    target: {
      accountId: params.accountId,
      peerKind: "direct",
      peerHash,
      ...(conversationHash ? { conversationHash } : {}),
      requestId,
      employee: {
        displayName: params.employee.displayName.trim(),
        email: params.employee.email.trim(),
        slug,
      },
      protectedRoute: {
        peerId: senderId,
        ...(params.conversationId?.trim() ? { conversationId: params.conversationId.trim() } : {}),
      },
    },
    cleanup: {
      pairingRequest: {
        namespace: "msteams-pairing-requests",
        key: senderId,
      },
      pendingRequest: {
        namespace: REQUEST_NAMESPACE,
        key: requestId,
      },
      routeBinding: {
        agentId,
        command: unbindRoute,
      },
      stack: {
        name: stackName,
        command: `docker stack rm ${shellSingleQuote(stackName)}`,
      },
      service: {
        name: serviceName,
        inspectCommand: `docker service ps ${shellSingleQuote(serviceName)} --no-trunc`,
      },
      secret: {
        name: secretName,
        command: `docker secret rm ${shellSingleQuote(secretName)}`,
      },
      auth: {
        agentId,
        provider: "openai",
        profileGlob: `${agentId}:openai:*`,
        orderKey: `${agentId}:openai`,
      },
      paths: [
        { kind: "root", path: root },
        { kind: "agent", path: `${root}/agent` },
        { kind: "config", path: `${root}/config` },
        { kind: "state", path: `${root}/state/.openclaw` },
        { kind: "workspace", path: `${root}/workspace` },
        { kind: "shared", path: `${root}/shared` },
        { kind: "stack", path: stackRoot },
      ],
    },
    validation: [
      "Teams direct peer no longer resolves to the reset employee agent",
      "legacy Teams pairing request for the direct peer is absent",
      "pending onboarding request key is absent",
      "employee Swarm stack and service are absent",
      "employee Docker secret is absent",
      "employee agent auth profile/order entries are absent",
      "employee scaffold paths are absent or archived according to the execution packet",
      "a new first Teams message recreates exactly one pending onboarding request",
    ],
    approvalRequired: true,
    sideEffects: [],
  };
}

export function redactMSTeamsEmployeeOnboardingResetPlan(
  plan: MSTeamsEmployeeOnboardingResetPlan,
): RedactedMSTeamsEmployeeOnboardingResetPlan {
  const { protectedRoute: _protectedRoute, ...target } = plan.target;
  const { pairingRequest: _pairingRequest, routeBinding: _routeBinding, ...cleanup } = plan.cleanup;

  return {
    ...plan,
    target: {
      ...target,
      ...(plan.target.protectedRoute
        ? {
            protectedRoute: {
              peerId: "[protected]" as const,
              ...(plan.target.peerHash ? { peerHash: plan.target.peerHash } : {}),
              ...(plan.target.protectedRoute.conversationId
                ? {
                    conversationId: "[protected]" as const,
                    conversationHash: plan.target.conversationHash,
                  }
                : {}),
            },
          }
        : {}),
    },
    cleanup: {
      ...cleanup,
      ...(plan.cleanup.pairingRequest
        ? {
            pairingRequest: {
              namespace: plan.cleanup.pairingRequest.namespace,
              key: "<protected>",
            },
          }
        : {}),
      ...(plan.cleanup.routeBinding
        ? {
            routeBinding: {
              agentId: plan.cleanup.routeBinding.agentId,
              command:
                "openclaw agents unbind --agent <slug> --bind msteams:<accountId> --peer-kind direct --peer-id <protected> --json",
            },
          }
        : {}),
    },
  };
}
