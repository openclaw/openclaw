/**
 * Fleet Capability Contract v1 — pure core.
 *
 * This module derives a read-only capability report for the agent fleet from
 * already-gathered inputs. It performs NO I/O: no filesystem access, no PATH
 * scanning, no env reads, no network. All probing happens in the command shell
 * (`src/commands/agents.commands.capabilities.ts`), which injects the booleans
 * and resolved strings below. Keeping the core pure makes the status logic
 * fully unit-testable and guarantees it can never leak a secret value.
 */

export type CapabilityStatus = "green" | "yellow" | "red";

/** Machine-readable failure reason codes (stable identifiers for tooling). */
export type CapabilityReasonCode =
  | "ok"
  | "profile_config_missing"
  | "model_unconfigured"
  | "provider_unknown"
  | "provider_credentials_missing"
  | "delegation_not_configured"
  | "delegation_model_unconfigured"
  | "delegation_credentials_missing"
  | "tools_unconfigured"
  | "tool_key_truncated"
  | "required_tool_missing"
  | "gateway_unconfigured"
  | "state_db_unavailable"
  | "cron_store_unavailable"
  | "github_cli_unavailable"
  | "github_auth_unavailable"
  | "linear_auth_unavailable"
  | "delivery_bridge_unavailable";

export type CapabilityCheck = {
  /** Stable check id, e.g. "profile.model" or "service.gateway". */
  id: string;
  /** Human-readable label. */
  label: string;
  status: CapabilityStatus;
  reason: CapabilityReasonCode;
  /** Human remediation hint. MUST NOT contain secret values. */
  detail?: string;
  /** When true, a failing check rolls up to red; otherwise to yellow. */
  required: boolean;
};

export type ProfileCapabilityReport = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  status: CapabilityStatus;
  checks: CapabilityCheck[];
};

export type CapabilityRollup = {
  green: number;
  yellow: number;
  red: number;
  /** Worst status across every check in the contract. */
  status: CapabilityStatus;
};

export type FleetCapabilityContract = {
  version: 1;
  /** ISO timestamp, injected by the shell (no clock read in core). */
  now: string;
  rollup: CapabilityRollup;
  services: CapabilityCheck[];
  profiles: ProfileCapabilityReport[];
};

export type ProfileCapabilityInput = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  /** Whether a config entry exists for this profile. */
  configPresent: boolean;
  /** Resolved primary model string (e.g. "anthropic/claude-opus-4-7"). */
  model?: string;
  /** Provider id derived from the model string prefix, if determinable. */
  provider?: string;
  /** Whether credentials for `provider` are present (name/presence only). */
  providerCredentialsPresent?: boolean;
  /** Whether a delegation (subagents) block is configured. */
  delegationConfigured: boolean;
  /** Resolved delegation/subagent model string. */
  delegationModel?: string;
  /** Provider id derived from the delegation model string. */
  delegationProvider?: string;
  /** Whether credentials for the delegation provider are present. */
  delegationCredentialsPresent?: boolean;
  /** Whether tools are configured (profile and/or allowlist present). */
  toolsConfigured: boolean;
  /** Raw tool keys, scanned for truncation/emptiness. Never printed wholesale. */
  toolKeys: string[];
  /** Optional required tool keys; absence rolls up to red. */
  requiredToolKeys?: string[];
  /** When true, missing provider credentials roll up to red (default true). */
  requireProvider?: boolean;
};

export type FleetServiceInput = {
  gatewayConfigured: boolean;
  gatewayRequired?: boolean;
  stateDbPresent: boolean;
  stateDbRequired?: boolean;
  cronStorePresent: boolean;
  cronRequired?: boolean;
  githubCliPresent: boolean;
  githubAuthPresent: boolean;
  githubRequired?: boolean;
  linearAuthPresent: boolean;
  linearRequired?: boolean;
  /** Delivery bridge / OneDrive sync (rclone) availability. */
  deliveryBridgePresent: boolean;
  deliveryRequired?: boolean;
};

export type FleetCapabilityInput = {
  now: string;
  profiles: ProfileCapabilityInput[];
  services: FleetServiceInput;
};

const STATUS_RANK: Record<CapabilityStatus, number> = {
  green: 0,
  yellow: 1,
  red: 2,
};

export function worstStatus(statuses: CapabilityStatus[]): CapabilityStatus {
  let worst: CapabilityStatus = "green";
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

/** A tool key is "truncated" if empty, whitespace-padded, or has a trailing ellipsis/null byte. */
export function isTruncatedToolKey(key: string): boolean {
  if (key.length === 0) {
    return true;
  }
  if (key !== key.trim()) {
    return true;
  }
  if (key.includes("\0")) {
    return true;
  }
  return key.endsWith("...") || key.endsWith("…");
}

/** Status for an optional service: present -> green, else red if required else yellow. */
function serviceStatus(present: boolean, required: boolean): CapabilityStatus {
  if (present) {
    return "green";
  }
  return required ? "red" : "yellow";
}

function buildProfileChecks(profile: ProfileCapabilityInput): CapabilityCheck[] {
  const checks: CapabilityCheck[] = [];
  const requireProvider = profile.requireProvider ?? true;

  // 1. Profile config exists.
  checks.push({
    id: "profile.config",
    label: "Profile config",
    status: profile.configPresent ? "green" : "red",
    reason: profile.configPresent ? "ok" : "profile_config_missing",
    detail: profile.configPresent
      ? undefined
      : "No config entry found for this profile; add it under agents.list.",
    required: true,
  });

  // 2. Configured model.
  const hasModel = Boolean(profile.model && profile.model.trim());
  checks.push({
    id: "profile.model",
    label: "Configured model",
    status: hasModel ? "green" : "red",
    reason: hasModel ? "ok" : "model_unconfigured",
    detail: hasModel
      ? undefined
      : "Set a model for this profile (agents.list[].model) or agents.defaults.model.",
    required: true,
  });

  // 3 + 4. Provider derivable + credentials present.
  if (hasModel) {
    const hasProvider = Boolean(profile.provider && profile.provider.trim());
    if (!hasProvider) {
      checks.push({
        id: "profile.provider",
        label: "Provider",
        status: "yellow",
        reason: "provider_unknown",
        detail: "Could not derive a provider from the model id; credential check skipped.",
        required: false,
      });
    } else {
      const credsPresent = profile.providerCredentialsPresent === true;
      checks.push({
        id: "profile.credentials",
        label: "Provider credentials",
        status: credsPresent ? "green" : requireProvider ? "red" : "yellow",
        reason: credsPresent ? "ok" : "provider_credentials_missing",
        detail: credsPresent
          ? undefined
          : `No credentials detected for provider "${profile.provider}". Set its auth env var or add an auth profile.`,
        required: requireProvider,
      });
    }
  }

  // 5. Delegation (subagents) provider/model.
  if (!profile.delegationConfigured) {
    checks.push({
      id: "profile.delegation",
      label: "Delegation",
      status: "green",
      reason: "delegation_not_configured",
      detail: "No subagent delegation configured (optional).",
      required: false,
    });
  } else {
    const hasDelegationModel = Boolean(profile.delegationModel && profile.delegationModel.trim());
    if (!hasDelegationModel) {
      checks.push({
        id: "profile.delegation.model",
        label: "Delegation model",
        status: "yellow",
        reason: "delegation_model_unconfigured",
        detail: "Subagents are configured but no delegation model resolves; set subagents.model.",
        required: false,
      });
    } else {
      const delegationCreds = profile.delegationCredentialsPresent === true;
      checks.push({
        id: "profile.delegation.credentials",
        label: "Delegation credentials",
        status: delegationCreds ? "green" : "yellow",
        reason: delegationCreds ? "ok" : "delegation_credentials_missing",
        detail: delegationCreds
          ? undefined
          : `No credentials detected for delegation provider "${profile.delegationProvider ?? "unknown"}".`,
        required: false,
      });
    }
  }

  // 6. Tools configured + integrity (truncated/empty keys) + required tools present.
  const truncatedKeys = profile.toolKeys.filter((key) => isTruncatedToolKey(key));
  if (truncatedKeys.length > 0) {
    checks.push({
      id: "profile.tools",
      label: "Tools",
      status: "red",
      reason: "tool_key_truncated",
      detail: `Found ${truncatedKeys.length} truncated/empty tool key(s); the tools config looks corrupted.`,
      required: true,
    });
  } else if (!profile.toolsConfigured) {
    checks.push({
      id: "profile.tools",
      label: "Tools",
      status: "yellow",
      reason: "tools_unconfigured",
      detail: "No tool profile or allowlist configured; this profile inherits defaults only.",
      required: false,
    });
  } else {
    checks.push({
      id: "profile.tools",
      label: "Tools",
      status: "green",
      reason: "ok",
      required: false,
    });
  }

  const requiredTools = profile.requiredToolKeys ?? [];
  if (requiredTools.length > 0) {
    const presentKeys = new Set(profile.toolKeys.map((key) => key.trim()));
    const missing = requiredTools.filter((key) => !presentKeys.has(key.trim()));
    if (missing.length > 0) {
      checks.push({
        id: "profile.tools.required",
        label: "Required tools",
        status: "red",
        reason: "required_tool_missing",
        detail: `Missing required tool(s): ${missing.join(", ")}.`,
        required: true,
      });
    }
  }

  return checks;
}

function buildServiceChecks(services: FleetServiceInput): CapabilityCheck[] {
  const gatewayRequired = services.gatewayRequired ?? false;
  const stateDbRequired = services.stateDbRequired ?? false;
  const cronRequired = services.cronRequired ?? false;
  const githubRequired = services.githubRequired ?? false;
  const linearRequired = services.linearRequired ?? false;
  const deliveryRequired = services.deliveryRequired ?? false;

  return [
    {
      id: "service.gateway",
      label: "Gateway",
      status: serviceStatus(services.gatewayConfigured, gatewayRequired),
      reason: services.gatewayConfigured ? "ok" : "gateway_unconfigured",
      detail: services.gatewayConfigured
        ? undefined
        : "No gateway is configured (gateway block absent).",
      required: gatewayRequired,
    },
    {
      id: "service.stateDb",
      label: "State DB (Kanban)",
      status: serviceStatus(services.stateDbPresent, stateDbRequired),
      reason: services.stateDbPresent ? "ok" : "state_db_unavailable",
      detail: services.stateDbPresent
        ? undefined
        : "OpenClaw state database not found; cron/board state is unavailable until initialized.",
      required: stateDbRequired,
    },
    {
      id: "service.cron",
      label: "Cron scheduler",
      status: serviceStatus(services.cronStorePresent, cronRequired),
      reason: services.cronStorePresent ? "ok" : "cron_store_unavailable",
      detail: services.cronStorePresent
        ? undefined
        : "No cron store found; scheduled jobs are not visible.",
      required: cronRequired,
    },
    {
      id: "service.github.cli",
      label: "GitHub CLI",
      status: serviceStatus(services.githubCliPresent, githubRequired),
      reason: services.githubCliPresent ? "ok" : "github_cli_unavailable",
      detail: services.githubCliPresent ? undefined : "gh not found on PATH.",
      required: githubRequired,
    },
    {
      id: "service.github.auth",
      label: "GitHub auth",
      status: serviceStatus(services.githubAuthPresent, githubRequired),
      reason: services.githubAuthPresent ? "ok" : "github_auth_unavailable",
      detail: services.githubAuthPresent
        ? undefined
        : "No GitHub token detected (GH_TOKEN/GITHUB_TOKEN unset).",
      required: githubRequired,
    },
    {
      id: "service.linear",
      label: "Linear auth",
      status: serviceStatus(services.linearAuthPresent, linearRequired),
      reason: services.linearAuthPresent ? "ok" : "linear_auth_unavailable",
      detail: services.linearAuthPresent
        ? undefined
        : "No Linear API key detected (LINEAR_API_KEY unset).",
      required: linearRequired,
    },
    {
      id: "service.delivery",
      label: "Delivery bridge (rclone/OneDrive)",
      status: serviceStatus(services.deliveryBridgePresent, deliveryRequired),
      reason: services.deliveryBridgePresent ? "ok" : "delivery_bridge_unavailable",
      detail: services.deliveryBridgePresent ? undefined : "rclone not found on PATH.",
      required: deliveryRequired,
    },
  ];
}

function tallyRollup(checks: CapabilityCheck[]): CapabilityRollup {
  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const check of checks) {
    if (check.status === "green") {
      green += 1;
    } else if (check.status === "yellow") {
      yellow += 1;
    } else {
      red += 1;
    }
  }
  return {
    green,
    yellow,
    red,
    status: worstStatus(checks.map((check) => check.status)),
  };
}

export function buildFleetCapabilityContract(input: FleetCapabilityInput): FleetCapabilityContract {
  const services = buildServiceChecks(input.services);
  const profiles: ProfileCapabilityReport[] = input.profiles.map((profile) => {
    const checks = buildProfileChecks(profile);
    return {
      agentId: profile.agentId,
      name: profile.name,
      isDefault: profile.isDefault,
      status: worstStatus(checks.map((check) => check.status)),
      checks,
    };
  });

  const allChecks = [...services, ...profiles.flatMap((report) => report.checks)];
  return {
    version: 1,
    now: input.now,
    rollup: tallyRollup(allChecks),
    services,
    profiles,
  };
}
