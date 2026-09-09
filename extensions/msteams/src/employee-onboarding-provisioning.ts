// Msteams plugin module renders dry-run employee-agent provisioning plans.
import { createHash } from "node:crypto";
import type {
  MSTeamsEmployeeOnboardingRequest,
  MSTeamsEmployeeOnboardingRequestStore,
  MSTeamsEmployeeOnboardingTerminalStatus,
  MSTeamsEmployeeOnboardingTransitionEvidence,
} from "./employee-onboarding.js";

export type MSTeamsEmployeeOnboardingProfile = {
  displayName: string;
  email: string;
  desiredSlug?: string;
  manager?: string;
  dataScope?: string;
  permissionTier?: string;
  bwsProjectName?: string;
};

export type MSTeamsEmployeeOnboardingProvisioningPlan = {
  dryRun: true;
  status: "ready";
  request: {
    id: string;
    channel: "msteams";
    accountId: string;
    peerKind: "direct";
    peerHash: string;
    conversationHash: string;
    requestedAt: string;
  };
  employee: {
    displayName: string;
    email: string;
    slug: string;
    manager?: string;
    dataScope?: string;
    permissionTier: string;
  };
  proposed: {
    agentId: string;
    stackName: string;
    serviceName: string;
    image: string;
    memoryScope: string;
    secretRef: string;
    bws: {
      employeeProjectName: string;
      sharedConnectorProjectName: string;
      machineAccountName: string;
      tokenSecretRef: string;
      accessTokenFile: string;
      resolverPath: string;
      providerAlias: "bws";
      requiredProjectAccess: string[];
      sharedConnectorSecretKeys: string[];
    };
    paths: {
      root: string;
      config: string;
      state: string;
      workspace: string;
      artifacts: string;
      taskInputs: string;
      taskResults: string;
      stackFile: string;
    };
    environment: Record<string, string>;
    routeBinding: {
      type: "route";
      agentId: string;
      match: {
        channel: "msteams";
        accountId: string;
        peer: {
          kind: "direct";
          id: string;
        };
      };
    };
  };
  commands: {
    createAgent: string;
    bindTeamsRoute: string;
    validateStack: string;
    deployStack: string;
    rollbackRoute: string;
    rollbackStack: string;
  };
  validation: string[];
  rollback: string[];
  approvalRequired: true;
  sideEffects: [];
};

export type MSTeamsEmployeeOnboardingProvisioningBlockedPlan = {
  dryRun: true;
  status: "blocked";
  requestId?: string;
  reason:
    | "missing-request"
    | "request-not-pending"
    | "missing-protected-route"
    | "missing-target-image"
    | "invalid-employee-profile";
  message: string;
  sideEffects: [];
};

export type MSTeamsEmployeeOnboardingProvisioningDryRun =
  | MSTeamsEmployeeOnboardingProvisioningPlan
  | MSTeamsEmployeeOnboardingProvisioningBlockedPlan;

export type MSTeamsEmployeeOnboardingProvisioningStackRender = {
  serviceName: string;
  image: string;
  environment: Record<string, string>;
  ports: [];
  volumes: Array<{
    type: "bind";
    source: string;
    target: string;
    readOnly?: true;
  }>;
};

export type MSTeamsEmployeeOnboardingExistingProvisioningState = {
  agentExists?: boolean;
  routeExists?: boolean;
  stackExists?: boolean;
  scaffoldPathExists?: Partial<
    Record<keyof MSTeamsEmployeeOnboardingProvisioningPlan["proposed"]["paths"], boolean>
  >;
};

export type MSTeamsEmployeeOnboardingImageApproval = {
  image: string;
  source: "active-release" | "config" | "target-host";
  approved: boolean;
  evidence?: string[];
};

export type MSTeamsEmployeeOnboardingImageApprovalInput = {
  candidateImage?: string;
  activeRuntimeVersion?: string;
  configuredImage?: string;
  targetHostImages?: string[];
};

export type MSTeamsEmployeeOnboardingExecutionReadinessProof = {
  dryRun: true;
  status: "ready" | "blocked";
  blockers: string[];
  idempotency: {
    agent: "create" | "skip-existing";
    route: "create" | "skip-existing";
    stack: "deploy" | "update-existing";
    scaffold: Record<
      keyof Omit<MSTeamsEmployeeOnboardingProvisioningPlan["proposed"]["paths"], "stackFile">,
      "create" | "reuse-existing"
    >;
  };
  image: MSTeamsEmployeeOnboardingImageApproval;
  hostBackedMounts: {
    required: string[];
    mounted: string[];
    missing: string[];
    passed: boolean;
  };
  ports: {
    published: [];
    passed: true;
  };
  routeValidation: string[];
  containerValidation: string[];
  approvalPacket: {
    required: true;
    summary: string;
    expectedChanges: string[];
    rollbackProof: string[];
  };
};

export type RedactedMSTeamsEmployeeOnboardingExecutionReadinessProof = Omit<
  MSTeamsEmployeeOnboardingExecutionReadinessProof,
  "approvalPacket"
> & {
  approvalPacket: Omit<
    MSTeamsEmployeeOnboardingExecutionReadinessProof["approvalPacket"],
    "rollbackProof"
  > & {
    rollbackProof: string[];
  };
};

export type MSTeamsEmployeeOnboardingAdminDryRunResult =
  | {
      dryRun: true;
      mode: "operator-admin";
      status: "ready";
      requestId: string;
      plan: RedactedMSTeamsEmployeeOnboardingProvisioningPlan;
      executionReadiness: RedactedMSTeamsEmployeeOnboardingExecutionReadinessProof;
      sideEffects: [];
    }
  | {
      dryRun: true;
      mode: "operator-admin";
      status: "blocked";
      requestId: string;
      blocker: MSTeamsEmployeeOnboardingProvisioningBlockedPlan;
      sideEffects: [];
    }
  | {
      dryRun: true;
      mode: "operator-admin";
      status: "blocked";
      requestId: string;
      plan: RedactedMSTeamsEmployeeOnboardingProvisioningPlan;
      executionReadiness: RedactedMSTeamsEmployeeOnboardingExecutionReadinessProof;
      sideEffects: [];
    };

export type MSTeamsEmployeeOnboardingAdminTransitionProof = {
  provisioningProofGreen?: boolean;
  linkedProofGreen?: boolean;
  routeProof?: string;
  stackProof?: string;
  serviceProof?: string;
  rollbackProof?: string;
  runnerImage?: string;
  agentId?: string;
  stackName?: string;
};

export type MSTeamsEmployeeOnboardingAdminTransitionResult =
  | {
      mode: "operator-admin";
      status: "transitioned" | "idempotent";
      requestId: string;
      requestStatus: MSTeamsEmployeeOnboardingTerminalStatus;
      transitionEvidence: MSTeamsEmployeeOnboardingTransitionEvidence;
      sideEffects: ["employee-onboarding-request-transition"];
    }
  | {
      mode: "operator-admin";
      status: "blocked";
      requestId: string;
      reason:
        | "missing-request"
        | "request-not-pending"
        | "conflicting-transition"
        | "transition-not-supported"
        | "proof-not-green"
        | "invalid-transition";
      message: string;
      sideEffects: [];
    };

export type RedactedMSTeamsEmployeeOnboardingProvisioningPlan = Omit<
  MSTeamsEmployeeOnboardingProvisioningPlan,
  "proposed" | "commands"
> & {
  proposed: Omit<MSTeamsEmployeeOnboardingProvisioningPlan["proposed"], "routeBinding"> & {
    routeBinding: Omit<
      MSTeamsEmployeeOnboardingProvisioningPlan["proposed"]["routeBinding"],
      "match"
    > & {
      match: Omit<
        MSTeamsEmployeeOnboardingProvisioningPlan["proposed"]["routeBinding"]["match"],
        "peer"
      > & {
        peer: {
          kind: "direct";
          id: "[protected]";
          hash: string;
        };
      };
    };
  };
  commands: Omit<
    MSTeamsEmployeeOnboardingProvisioningPlan["commands"],
    "bindTeamsRoute" | "rollbackRoute"
  > & {
    bindTeamsRoute: string;
    rollbackRoute: string;
  };
};

const DEFAULT_EMPLOYEE_AGENT_MODEL = "openai/gpt-5.5";
const DEFAULT_EMPLOYEE_AGENT_IMAGE_REPOSITORY = "local/openclaw-gateway";
const DEFAULT_EMPLOYEE_AGENT_ROOT = "/srv/openclaw/data/employee-agents";
const DEFAULT_EMPLOYEE_STACK_ROOT = "/srv/openclaw/stacks";
const DEFAULT_EMPLOYEE_PERMISSION_TIER = "employee-standard-v1";
const DEFAULT_EMPLOYEE_CONNECTOR_PROJECT_NAME = "openclaw-employee-connectors";
const DEFAULT_BWS_RESOLVER_PATH = "/home/openclaw/config/openclaw-bws-resolver.mjs";
const SHARED_CONNECTOR_SECRET_KEYS = [
  "openclaw/connectors/salesforce/sfdxAuthJson",
  "openclaw/connectors/salesforce/defaultTargetOrg",
  "openclaw/connectors/krisp/oauthStoreJson",
  "openclaw/connectors/krisp/mcpServerConfig",
  "openclaw/connectors/krisp/serviceIdentity",
] as const;

function normalizeSlug(input: string | undefined): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function slugFromProfile(profile: MSTeamsEmployeeOnboardingProfile): string {
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

function bwsEmployeeProjectName(profile: MSTeamsEmployeeOnboardingProfile, slug: string): string {
  return profile.bwsProjectName?.trim() || `openclaw-${slug}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function hashProofValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

function validateProfile(profile: MSTeamsEmployeeOnboardingProfile): string | null {
  if (!profile.displayName.trim()) {
    return "Employee display name is required.";
  }
  if (!profile.email.trim()) {
    return "Employee email/UPN is required.";
  }
  if (!slugFromProfile(profile)) {
    return "Employee slug could not be derived.";
  }
  return null;
}

function normalizeImageRef(value: string | undefined): string {
  return (value ?? "").trim();
}

function imageRefFromRuntimeVersion(version: string | undefined): string {
  const normalized = normalizeImageRef(version);
  return normalized ? `${DEFAULT_EMPLOYEE_AGENT_IMAGE_REPOSITORY}:${normalized}` : "";
}

export function resolveMSTeamsEmployeeOnboardingImageApproval(
  input: MSTeamsEmployeeOnboardingImageApprovalInput,
): MSTeamsEmployeeOnboardingImageApproval {
  const candidateImage = normalizeImageRef(input.candidateImage);
  const configuredImage = normalizeImageRef(input.configuredImage);
  const activeRuntimeImage = imageRefFromRuntimeVersion(input.activeRuntimeVersion);
  const targetHostImages = new Set((input.targetHostImages ?? []).map(normalizeImageRef));
  const evidence: string[] = [];
  if (!candidateImage) {
    return {
      image: "",
      source: "config",
      approved: false,
      evidence: ["candidate image is required"],
    };
  }
  if (targetHostImages.size > 0) {
    if (targetHostImages.has(candidateImage)) {
      evidence.push(`present in target-host image inventory as ${candidateImage}`);
      return {
        image: candidateImage,
        source: "target-host",
        approved: true,
        evidence,
      };
    }
    return {
      image: candidateImage,
      source: "target-host",
      approved: false,
      evidence: [
        ...(configuredImage ? [`configured image is ${configuredImage}`] : []),
        ...(activeRuntimeImage ? [`active runtime image would be ${activeRuntimeImage}`] : []),
        "candidate image not present in target-host inventory",
      ],
    };
  }
  if (configuredImage && configuredImage === candidateImage) {
    evidence.push(`matches configured image ${configuredImage}`);
    return {
      image: candidateImage,
      source: "config",
      approved: true,
      evidence,
    };
  }
  if (activeRuntimeImage && activeRuntimeImage === candidateImage) {
    evidence.push(`derived from active runtime version ${input.activeRuntimeVersion}`);
    return {
      image: candidateImage,
      source: "active-release",
      approved: true,
      evidence,
    };
  }
  return {
    image: candidateImage,
    source: configuredImage
      ? "config"
      : targetHostImages.size > 0
        ? "target-host"
        : "active-release",
    approved: false,
    evidence: [
      ...(configuredImage ? [`configured image is ${configuredImage}`] : []),
      ...(activeRuntimeImage ? [`active runtime image would be ${activeRuntimeImage}`] : []),
      ...(targetHostImages.size > 0
        ? ["candidate image not present in target-host inventory"]
        : []),
    ],
  };
}

export function createMSTeamsEmployeeOnboardingProvisioningDryRun(params: {
  request: MSTeamsEmployeeOnboardingRequest;
  employee: MSTeamsEmployeeOnboardingProfile;
  roots?: {
    employeeAgentRoot?: string;
    stackRoot?: string;
  };
  model?: string;
  image: string;
}): MSTeamsEmployeeOnboardingProvisioningDryRun {
  const profileError = validateProfile(params.employee);
  if (profileError) {
    return {
      dryRun: true,
      status: "blocked",
      requestId: params.request.id,
      reason: "invalid-employee-profile",
      message: profileError,
      sideEffects: [],
    };
  }
  if (params.request.status !== "pending") {
    return {
      dryRun: true,
      status: "blocked",
      requestId: params.request.id,
      reason: "request-not-pending",
      message: "Only pending Teams employee onboarding requests can be provisioned.",
      sideEffects: [],
    };
  }
  if (!params.request.protectedRoute?.peerId || !params.request.protectedRoute.conversationId) {
    return {
      dryRun: true,
      status: "blocked",
      requestId: params.request.id,
      reason: "missing-protected-route",
      message:
        "Pending request does not include protected Teams route data; exact direct-peer binding cannot be created.",
      sideEffects: [],
    };
  }
  const image = params.image.trim();
  if (!image) {
    return {
      dryRun: true,
      status: "blocked",
      requestId: params.request.id,
      reason: "missing-target-image",
      message:
        "Target employee-agent image is required; derive it from the active release/config or approved target-host image before execution.",
      sideEffects: [],
    };
  }

  const slug = slugFromProfile(params.employee);
  const agentId = slug;
  const stackName = `employee-agent-${slug}`;
  const serviceName = `employee-agent-${slug}`;
  const root = `${params.roots?.employeeAgentRoot ?? DEFAULT_EMPLOYEE_AGENT_ROOT}/${slug}`;
  const stackRoot = `${params.roots?.stackRoot ?? DEFAULT_EMPLOYEE_STACK_ROOT}/${stackName}`;
  const secretRef = `employee_agent_${slug.replace(/-/gu, "_")}_token_v1`;
  const bwsTokenSecretRef = `employee_agent_${slug.replace(/-/gu, "_")}_bws_token_v1`;
  const memoryScope = `employee-agent-${slug}`;
  const permissionTier = params.employee.permissionTier?.trim() || DEFAULT_EMPLOYEE_PERMISSION_TIER;
  const model = params.model?.trim() || DEFAULT_EMPLOYEE_AGENT_MODEL;
  const employeeBwsProjectName = bwsEmployeeProjectName(params.employee, slug);
  const machineAccountName = `openclaw-employee-${slug}`;
  const routePeerId = params.request.protectedRoute.peerId;
  const bindTeamsRoute = `openclaw agents bind --agent ${shellSingleQuote(agentId)} --bind msteams:${shellSingleQuote(
    params.request.accountId,
  )} --peer-kind direct --peer-id ${shellSingleQuote(routePeerId)} --json`;
  const rollbackRoute = `openclaw agents unbind --agent ${shellSingleQuote(
    agentId,
  )} --bind msteams:${shellSingleQuote(params.request.accountId)} --peer-kind direct --peer-id ${shellSingleQuote(
    routePeerId,
  )} --json`;

  return {
    dryRun: true,
    status: "ready",
    request: {
      id: params.request.id,
      channel: params.request.channel,
      accountId: params.request.accountId,
      peerKind: params.request.peerKind,
      peerHash: params.request.peerHash,
      conversationHash: params.request.conversationHash,
      requestedAt: params.request.requestedAt,
    },
    employee: {
      displayName: params.employee.displayName.trim(),
      email: params.employee.email.trim(),
      slug,
      ...(params.employee.manager?.trim() ? { manager: params.employee.manager.trim() } : {}),
      ...(params.employee.dataScope?.trim() ? { dataScope: params.employee.dataScope.trim() } : {}),
      permissionTier,
    },
    proposed: {
      agentId,
      stackName,
      serviceName,
      image,
      memoryScope,
      secretRef,
      bws: {
        employeeProjectName: employeeBwsProjectName,
        sharedConnectorProjectName: DEFAULT_EMPLOYEE_CONNECTOR_PROJECT_NAME,
        machineAccountName,
        tokenSecretRef: bwsTokenSecretRef,
        accessTokenFile: "/run/secrets/employee_bws_access_token",
        resolverPath: DEFAULT_BWS_RESOLVER_PATH,
        providerAlias: "bws",
        requiredProjectAccess: [employeeBwsProjectName, DEFAULT_EMPLOYEE_CONNECTOR_PROJECT_NAME],
        sharedConnectorSecretKeys: [...SHARED_CONNECTOR_SECRET_KEYS],
      },
      paths: {
        root,
        config: `${root}/config`,
        state: `${root}/state/.openclaw`,
        workspace: `${root}/workspace`,
        artifacts: `${root}/shared/artifacts`,
        taskInputs: `${root}/shared/task-inputs`,
        taskResults: `${root}/shared/task-results`,
        stackFile: `${stackRoot}/stack.yml`,
      },
      environment: {
        OPENCLAW_AGENT_OWNER: agentId,
        OPENCLAW_AGENT_SCOPE: "user",
        OPENCLAW_APPROVAL_CLASS: "draft-prepare",
        OPENCLAW_CONFIG_PATH: "/home/openclaw/config/openclaw.json",
        OPENCLAW_DISABLED_CHANNELS: "telegram",
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN_FILE: "/run/secrets/employee_agent_token",
        OPENCLAW_MEMORY_SCOPE: memoryScope,
        OPENCLAW_PRIMARY_CHANNEL: "msteams",
        OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw",
        OPENCLAW_TOOL_POLICY: permissionTier,
        BWS_ACCESS_TOKEN_FILE: "/run/secrets/employee_bws_access_token",
      },
      routeBinding: {
        type: "route",
        agentId,
        match: {
          channel: "msteams",
          accountId: params.request.accountId,
          peer: {
            kind: "direct",
            id: routePeerId,
          },
        },
      },
    },
    commands: {
      createAgent: `openclaw agents add ${shellSingleQuote(agentId)} --workspace ${shellSingleQuote(
        `${root}/workspace`,
      )} --agent-dir ${shellSingleQuote(`${root}/agent`)} --model ${shellSingleQuote(
        model,
      )} --non-interactive --json`,
      bindTeamsRoute,
      validateStack: `docker stack config -c ${shellSingleQuote(`${stackRoot}/stack.yml`)}`,
      deployStack: `docker stack deploy -c ${shellSingleQuote(
        `${stackRoot}/stack.yml`,
      )} ${shellSingleQuote(stackName)}`,
      rollbackRoute,
      rollbackStack: `docker stack rm ${shellSingleQuote(stackName)}`,
    },
    validation: [
      "rendered employee config validates",
      "rendered stack passes docker stack config",
      `${serviceName} service reaches 1/1`,
      "employee BWS token sees the employee project and shared connector project required for its scope",
      "shared Salesforce and Krisp connector SecretRefs resolve from BWS without exposing values",
      "employee-agent endpoint ports remain unpublished",
      "new Teams direct peer routes to the new employee agent",
      "Kevin Teams direct peer still routes to kevin-k",
      "Telegram routes still resolve to main",
      "production health validation remains green",
    ],
    rollback: [
      "remove the new Teams direct-peer route",
      "remove the isolated employee-agent Swarm stack",
      "retain employee filesystem scaffold and gateway/BWS secrets until Kevin approves cleanup",
    ],
    approvalRequired: true,
    sideEffects: [],
  };
}

export function renderMSTeamsEmployeeOnboardingProvisioningStack(
  plan: MSTeamsEmployeeOnboardingProvisioningPlan,
): MSTeamsEmployeeOnboardingProvisioningStackRender {
  const paths = plan.proposed.paths;
  return {
    serviceName: plan.proposed.serviceName,
    image: plan.proposed.image,
    environment: plan.proposed.environment,
    ports: [],
    volumes: [
      {
        type: "bind",
        source: paths.config,
        target: "/home/openclaw/config",
        readOnly: true,
      },
      {
        type: "bind",
        source: paths.state,
        target: "/home/openclaw/.openclaw",
      },
      {
        type: "bind",
        source: paths.workspace,
        target: "/home/openclaw/workspace",
      },
      {
        type: "bind",
        source: paths.artifacts,
        target: "/shared/artifacts",
      },
      {
        type: "bind",
        source: paths.taskInputs,
        target: "/shared/task-inputs",
        readOnly: true,
      },
      {
        type: "bind",
        source: paths.taskResults,
        target: "/shared/task-results",
      },
    ],
  };
}

function scaffoldPathActions(params: {
  plan: MSTeamsEmployeeOnboardingProvisioningPlan;
  existing?: MSTeamsEmployeeOnboardingExistingProvisioningState;
}): MSTeamsEmployeeOnboardingExecutionReadinessProof["idempotency"]["scaffold"] {
  const pathKeys = [
    "root",
    "config",
    "state",
    "workspace",
    "artifacts",
    "taskInputs",
    "taskResults",
  ] as const;
  return Object.fromEntries(
    pathKeys.map((key) => [
      key,
      params.existing?.scaffoldPathExists?.[key] ? "reuse-existing" : "create",
    ]),
  ) as MSTeamsEmployeeOnboardingExecutionReadinessProof["idempotency"]["scaffold"];
}

export function createMSTeamsEmployeeOnboardingExecutionReadinessProof(params: {
  plan: MSTeamsEmployeeOnboardingProvisioningPlan;
  existing?: MSTeamsEmployeeOnboardingExistingProvisioningState;
  image: MSTeamsEmployeeOnboardingImageApproval;
}): MSTeamsEmployeeOnboardingExecutionReadinessProof {
  const stack = renderMSTeamsEmployeeOnboardingProvisioningStack(params.plan);
  const requiredMountSources = [
    params.plan.proposed.paths.config,
    params.plan.proposed.paths.state,
    params.plan.proposed.paths.workspace,
    params.plan.proposed.paths.artifacts,
    params.plan.proposed.paths.taskInputs,
    params.plan.proposed.paths.taskResults,
  ];
  const mountedSources = stack.volumes
    .filter((volume) => volume.type === "bind")
    .map((volume) => volume.source);
  const missingMounts = requiredMountSources.filter((source) => !mountedSources.includes(source));
  const blockers = [
    ...(params.image.approved ? [] : [`Target image is not approved: ${params.image.image}`]),
    ...(missingMounts.length === 0
      ? []
      : [`Generated stack is missing host-backed bind mounts: ${missingMounts.join(", ")}`]),
  ];
  return {
    dryRun: true,
    status: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    idempotency: {
      agent: params.existing?.agentExists ? "skip-existing" : "create",
      route: params.existing?.routeExists ? "skip-existing" : "create",
      stack: params.existing?.stackExists ? "update-existing" : "deploy",
      scaffold: scaffoldPathActions({ plan: params.plan, existing: params.existing }),
    },
    image: params.image,
    hostBackedMounts: {
      required: requiredMountSources,
      mounted: mountedSources,
      missing: missingMounts,
      passed: missingMounts.length === 0,
    },
    ports: {
      published: stack.ports,
      passed: true,
    },
    routeValidation: [
      "new Teams direct peer resolves to the employee agent",
      "Kevin Teams direct peer still resolves to kevin-k",
      "Telegram routes still resolve to main",
    ],
    containerValidation: [
      `${params.plan.proposed.serviceName} reaches 1/1`,
      "employee service endpoint ports inspect returns no published ports",
      "employee BWS project access proof succeeds from inside the container",
      "shared connector SecretRefs resolve from BWS without value exposure",
      "production health validation remains green",
    ],
    approvalPacket: {
      required: true,
      summary: `Approve employee onboarding execution for ${params.plan.employee.slug} from pending request ${params.plan.request.id}.`,
      expectedChanges: [
        `managed agent ${params.plan.proposed.agentId}`,
        `host-backed scaffold under ${params.plan.proposed.paths.root}`,
        `Swarm stack ${params.plan.proposed.stackName}`,
        `secret reference ${params.plan.proposed.secretRef}`,
        `employee BWS project ${params.plan.proposed.bws.employeeProjectName}`,
        `employee BWS machine account ${params.plan.proposed.bws.machineAccountName}`,
        `employee BWS token secret reference ${params.plan.proposed.bws.tokenSecretRef}`,
        `read access to shared connector project ${params.plan.proposed.bws.sharedConnectorProjectName}`,
        "one exact Teams direct-peer route binding",
      ],
      rollbackProof: [
        params.plan.commands.rollbackRoute,
        params.plan.commands.rollbackStack,
        "retain scaffold and secret until explicit cleanup approval",
      ],
    },
  };
}

export async function createMSTeamsEmployeeOnboardingProvisioningDryRunFromStore(params: {
  store: Pick<MSTeamsEmployeeOnboardingRequestStore, "getRequest">;
  requestId: string;
  employee: MSTeamsEmployeeOnboardingProfile;
  image: string;
}): Promise<MSTeamsEmployeeOnboardingProvisioningDryRun> {
  const request = await params.store.getRequest?.(params.requestId);
  if (!request) {
    return {
      dryRun: true,
      status: "blocked",
      requestId: params.requestId,
      reason: "missing-request",
      message: "Pending Teams employee onboarding request was not found.",
      sideEffects: [],
    };
  }
  return createMSTeamsEmployeeOnboardingProvisioningDryRun({
    request,
    employee: params.employee,
    image: params.image,
  });
}

export function redactMSTeamsEmployeeOnboardingProvisioningDryRun(
  dryRun: MSTeamsEmployeeOnboardingProvisioningDryRun,
): MSTeamsEmployeeOnboardingProvisioningDryRun | RedactedMSTeamsEmployeeOnboardingProvisioningPlan {
  if (dryRun.status === "blocked") {
    return dryRun;
  }
  return {
    ...dryRun,
    proposed: {
      ...dryRun.proposed,
      routeBinding: {
        type: dryRun.proposed.routeBinding.type,
        agentId: dryRun.proposed.routeBinding.agentId,
        match: {
          channel: dryRun.proposed.routeBinding.match.channel,
          accountId: dryRun.proposed.routeBinding.match.accountId,
          peer: {
            kind: "direct",
            id: "[protected]",
            hash: dryRun.request.peerHash,
          },
        },
      },
    },
    commands: {
      ...dryRun.commands,
      bindTeamsRoute:
        "openclaw agents bind --agent <slug> --bind msteams:<accountId> --peer-kind direct --peer-id <protected> --json",
      rollbackRoute:
        "openclaw agents unbind --agent <slug> --bind msteams:<accountId> --peer-kind direct --peer-id <protected> --json",
    },
  };
}

export function redactMSTeamsEmployeeOnboardingExecutionReadinessProof(
  proof: MSTeamsEmployeeOnboardingExecutionReadinessProof,
): RedactedMSTeamsEmployeeOnboardingExecutionReadinessProof {
  return {
    ...proof,
    approvalPacket: {
      ...proof.approvalPacket,
      rollbackProof: proof.approvalPacket.rollbackProof.map((entry) =>
        entry.includes("--peer-id")
          ? "openclaw agents unbind --agent <slug> --bind msteams:<accountId> --peer-kind direct --peer-id <protected> --json"
          : entry,
      ),
    },
  };
}

function transitionPreconditionBlocker(params: {
  status: MSTeamsEmployeeOnboardingTerminalStatus;
  proof: MSTeamsEmployeeOnboardingAdminTransitionProof;
  failureCode?: string;
}): string | null {
  switch (params.status) {
    case "provisioned":
      return params.proof.provisioningProofGreen &&
        params.proof.routeProof?.trim() &&
        params.proof.stackProof?.trim() &&
        params.proof.serviceProof?.trim()
        ? null
        : "Provisioned transition requires green route, stack, and service proof.";
    case "linked":
      return params.proof.linkedProofGreen && params.proof.routeProof?.trim()
        ? null
        : "Linked transition requires green existing-route/agent proof.";
    case "failed":
      return params.failureCode?.trim() ? null : "Failed transition requires a failure code.";
    case "rolled_back":
      return params.proof.rollbackProof?.trim()
        ? null
        : "Rolled-back transition requires rollback proof.";
  }
}

function createTransitionEvidence(params: {
  request: MSTeamsEmployeeOnboardingRequest;
  proof: MSTeamsEmployeeOnboardingAdminTransitionProof;
}): MSTeamsEmployeeOnboardingTransitionEvidence {
  return {
    operator: "employee-onboarding-admin",
    requestId: params.request.id,
    peerHash: params.request.peerHash,
    ...(params.proof.runnerImage?.trim() ? { runnerImage: params.proof.runnerImage.trim() } : {}),
    ...(hashProofValue(params.proof.agentId)
      ? { agentIdHash: hashProofValue(params.proof.agentId) }
      : {}),
    ...(hashProofValue(params.proof.stackName)
      ? { stackNameHash: hashProofValue(params.proof.stackName) }
      : {}),
    ...(hashProofValue(params.proof.routeProof)
      ? { routeProofHash: hashProofValue(params.proof.routeProof) }
      : {}),
    ...(hashProofValue(params.proof.serviceProof)
      ? { serviceProofHash: hashProofValue(params.proof.serviceProof) }
      : {}),
    ...(hashProofValue(params.proof.rollbackProof)
      ? { rollbackProofHash: hashProofValue(params.proof.rollbackProof) }
      : {}),
  };
}

export async function createMSTeamsEmployeeOnboardingAdminTransition(params: {
  store: Pick<MSTeamsEmployeeOnboardingRequestStore, "getRequest" | "transitionRequest">;
  requestId: string;
  status: MSTeamsEmployeeOnboardingTerminalStatus;
  proof: MSTeamsEmployeeOnboardingAdminTransitionProof;
  transitionedAt?: string;
  transitionReason?: string;
  failureCode?: string;
}): Promise<MSTeamsEmployeeOnboardingAdminTransitionResult> {
  if (!params.store.transitionRequest) {
    return {
      mode: "operator-admin",
      status: "blocked",
      requestId: params.requestId,
      reason: "transition-not-supported",
      message: "Teams employee onboarding request store does not support lifecycle transitions.",
      sideEffects: [],
    };
  }

  const request = await params.store.getRequest?.(params.requestId);
  if (!request) {
    return {
      mode: "operator-admin",
      status: "blocked",
      requestId: params.requestId,
      reason: "missing-request",
      message: "Teams employee onboarding request was not found.",
      sideEffects: [],
    };
  }

  const blocker = transitionPreconditionBlocker({
    status: params.status,
    proof: params.proof,
    failureCode: params.failureCode,
  });
  if (blocker) {
    return {
      mode: "operator-admin",
      status: "blocked",
      requestId: params.requestId,
      reason: "proof-not-green",
      message: blocker,
      sideEffects: [],
    };
  }

  const transitionEvidence = createTransitionEvidence({ request, proof: params.proof });
  const result = await params.store.transitionRequest(params.requestId, {
    status: params.status,
    transitionedAt: params.transitionedAt,
    transitionReason: params.transitionReason,
    transitionEvidence,
    failureCode: params.failureCode,
  });
  if (result.status === "blocked") {
    return {
      mode: "operator-admin",
      status: "blocked",
      requestId: params.requestId,
      reason: result.reason,
      message: result.message,
      sideEffects: [],
    };
  }
  return {
    mode: "operator-admin",
    status: result.status,
    requestId: params.requestId,
    requestStatus: result.request.status as MSTeamsEmployeeOnboardingTerminalStatus,
    transitionEvidence,
    sideEffects: result.sideEffects,
  };
}

export async function createMSTeamsEmployeeOnboardingAdminDryRun(params: {
  store: Pick<MSTeamsEmployeeOnboardingRequestStore, "getRequest">;
  requestId: string;
  employee: MSTeamsEmployeeOnboardingProfile;
  image: MSTeamsEmployeeOnboardingImageApproval;
  existing?: MSTeamsEmployeeOnboardingExistingProvisioningState;
}): Promise<MSTeamsEmployeeOnboardingAdminDryRunResult> {
  const plan = await createMSTeamsEmployeeOnboardingProvisioningDryRunFromStore({
    store: params.store,
    requestId: params.requestId,
    employee: params.employee,
    image: params.image.image,
  });
  if (plan.status === "blocked") {
    return {
      dryRun: true,
      mode: "operator-admin",
      status: "blocked",
      requestId: params.requestId,
      blocker: plan,
      sideEffects: [],
    };
  }
  const proof = createMSTeamsEmployeeOnboardingExecutionReadinessProof({
    plan,
    existing: params.existing,
    image: params.image,
  });
  const redactedPlan = redactMSTeamsEmployeeOnboardingProvisioningDryRun(
    plan,
  ) as RedactedMSTeamsEmployeeOnboardingProvisioningPlan;
  const redactedProof = redactMSTeamsEmployeeOnboardingExecutionReadinessProof(proof);
  if (proof.status === "blocked") {
    return {
      dryRun: true,
      mode: "operator-admin",
      status: "blocked",
      requestId: params.requestId,
      plan: redactedPlan,
      executionReadiness: redactedProof,
      sideEffects: [],
    };
  }
  return {
    dryRun: true,
    mode: "operator-admin",
    status: "ready",
    requestId: params.requestId,
    plan: redactedPlan,
    executionReadiness: redactedProof,
    sideEffects: [],
  };
}
