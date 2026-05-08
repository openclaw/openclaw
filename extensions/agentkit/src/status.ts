import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  resolveAgentkitEntryState,
  resolveConfiguredAgentkitPluginConfig,
  type AgentkitHitlMode,
  type AgentkitPluginEntryState,
} from "./config.js";
import { resolveExecutablePath } from "./local-cli.js";

export type AgentkitPluginStateLabel =
  | "not-configured"
  | "configured-not-enabled"
  | "configured-disabled"
  | "configured-enabled";

export type AgentkitStatusSnapshot = {
  phase: "world-agentkit";
  plugin: {
    state: AgentkitPluginStateLabel;
    configured: boolean;
    enabled: boolean;
  };
  walletAddress: string | null;
  hitl: {
    enabled: boolean;
    mode: AgentkitHitlMode;
    resourceUrl: string | null;
    protectedTools: string[];
    grantScope: "session" | "agent";
    humanApproval: {
      provider: "hosted" | "custom";
      brokerUrl: string | null;
      appId: string | null;
      rpId: string | null;
      signingKeyConfigured: boolean;
      signingKeyEnvVar: string | null;
      environment: "production" | "staging";
      actionPrefix: string;
    };
  };
  cli: {
    command: string;
    args: string[];
    available: boolean;
    resolvedPath: string | null;
  };
  checks: {
    readyForRegistration: boolean;
    readyForRuntime: boolean;
    readyForHitl: boolean;
    readyForHumanApproval: boolean;
  };
  nextSteps: string[];
};

function resolveAgentkitPluginStateLabel(
  entryState: AgentkitPluginEntryState,
): AgentkitPluginStateLabel {
  if (!entryState.configured) {
    return "not-configured";
  }
  if (entryState.explicitlyDisabled) {
    return "configured-disabled";
  }
  if (entryState.effectiveEnabled) {
    return "configured-enabled";
  }
  return "configured-not-enabled";
}

function buildNextSteps(params: {
  pluginState: AgentkitPluginStateLabel;
  hitlEnabled: boolean;
  hitlMode: AgentkitHitlMode;
  hitlProtectedTools: string[];
  hitlResourceUrl: string | null;
  humanApprovalBrokerUrl: string | null;
  humanApprovalProvider: "hosted" | "custom";
  humanApprovalAppId: string | null;
  humanApprovalRpId: string | null;
  humanApprovalSigningKeyConfigured: boolean;
  walletAddress: string | null;
  cliCommand: string;
  cliAvailable: boolean;
}): string[] {
  const steps: string[] = [];
  if (params.pluginState !== "configured-enabled") {
    steps.push("Enable the plugin with `plugins.entries.agentkit.enabled=true`.");
  }
  if (params.hitlMode === "delegation" && !params.walletAddress) {
    steps.push(
      "Set `plugins.entries.agentkit.config.walletAddress` to the agent wallet you plan to register.",
    );
  }
  if (params.hitlMode === "delegation" && !params.cliAvailable) {
    steps.push(
      `Install the AgentKit CLI or expose \`${params.cliCommand}\` on PATH. For an npx-based setup, set \`plugins.entries.agentkit.config.cli.command="npx"\` and \`plugins.entries.agentkit.config.cli.args=["-y","@worldcoin/agentkit-cli"]\`.`,
    );
  }
  if (params.hitlMode === "delegation" && params.walletAddress && params.cliAvailable) {
    steps.push(
      "Run `openclaw agentkit register` to start the local AgentKit wallet registration flow.",
    );
  }
  steps.push(
    "Run `openclaw agentkit verify-header --resource <url> --header-file <path>` to inspect a captured AgentKit header.",
  );
  steps.push(
    "Run `openclaw agentkit verifier-server` and `openclaw agentkit verifier-request --server <origin>` to exercise the local verifier flow.",
  );
  steps.push(
    "Run `openclaw agentkit request --resource <url> --private-key-file <path>` to try a protected resource with a specific signer.",
  );
  if (params.hitlEnabled && params.hitlProtectedTools.length === 0) {
    steps.push(
      "Set `plugins.entries.agentkit.config.hitl.protectedTools` to the tool names that should require World-backed delegation.",
    );
  }
  if (params.hitlEnabled && params.hitlMode === "delegation" && !params.hitlResourceUrl) {
    steps.push(
      "Set `plugins.entries.agentkit.config.hitl.resourceUrl` so protected tool approvals can verify against an AgentKit-protected resource.",
    );
  }
  if (
    params.hitlEnabled &&
    params.hitlMode === "human-approval" &&
    params.humanApprovalProvider === "hosted" &&
    !params.humanApprovalBrokerUrl
  ) {
    steps.push(
      "Set `plugins.entries.agentkit.config.hitl.humanApproval.brokerUrl` so OpenClaw can request hosted World approval signatures.",
    );
  }
  if (
    params.hitlEnabled &&
    params.hitlMode === "human-approval" &&
    params.humanApprovalProvider === "custom" &&
    !params.humanApprovalAppId
  ) {
    steps.push(
      "Set `plugins.entries.agentkit.config.hitl.humanApproval.appId` to the World app_id that should issue QR-based approvals.",
    );
  }
  if (
    params.hitlEnabled &&
    params.hitlMode === "human-approval" &&
    params.humanApprovalProvider === "custom" &&
    !params.humanApprovalRpId
  ) {
    steps.push(
      "Set `plugins.entries.agentkit.config.hitl.humanApproval.rpId` to the World rp_id that should verify approval proofs.",
    );
  }
  if (
    params.hitlEnabled &&
    params.hitlMode === "human-approval" &&
    params.humanApprovalProvider === "custom" &&
    !params.humanApprovalSigningKeyConfigured
  ) {
    steps.push(
      "Set `plugins.entries.agentkit.config.hitl.humanApproval.signingKeyEnvVar` and provide that environment variable so OpenClaw can mint World approval requests without storing the signing key in config.",
    );
  }
  if (
    params.hitlEnabled &&
    params.hitlMode === "delegation" &&
    params.hitlResourceUrl &&
    params.hitlProtectedTools.length > 0
  ) {
    steps.push(
      "Use `openclaw agentkit approvals` and `openclaw agentkit approve` to resolve pending AgentKit HITL requests after a successful proof-backed check.",
    );
  }
  if (
    params.hitlEnabled &&
    params.hitlMode === "human-approval" &&
    (params.humanApprovalProvider === "hosted"
      ? params.humanApprovalBrokerUrl != null
      : params.humanApprovalAppId != null &&
        params.humanApprovalRpId != null &&
        params.humanApprovalSigningKeyConfigured) &&
    params.hitlProtectedTools.length > 0
  ) {
    steps.push(
      "Use `openclaw agentkit approve --approval-id <id>` to print a World QR/link, scan it in World App, and resolve the pending OpenClaw approval after proof verification.",
    );
  }
  return steps;
}

function formatPluginStateLabel(state: AgentkitPluginStateLabel): string {
  switch (state) {
    case "configured-enabled":
      return "configured and enabled";
    case "configured-disabled":
      return "configured but disabled";
    case "configured-not-enabled":
      return "configured but not enabled";
    case "not-configured":
    default:
      return "not configured";
  }
}

export async function resolveAgentkitStatus(params: {
  appConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentkitStatusSnapshot> {
  const entryState = resolveAgentkitEntryState(params.appConfig);
  const pluginConfig = resolveConfiguredAgentkitPluginConfig(params.appConfig);
  const walletAddress = pluginConfig.walletAddress ?? null;
  const resolvedPath = await resolveExecutablePath({
    command: pluginConfig.cli.command,
    env: params.env,
  });
  const pluginState = resolveAgentkitPluginStateLabel(entryState);
  const cliAvailable = resolvedPath != null;
  const humanApproval = pluginConfig.hitl.humanApproval;
  const humanApprovalSigningKeyConfigured =
    humanApproval.signingKey != null ||
    (humanApproval.signingKeyEnvVar != null &&
      Boolean(params.env?.[humanApproval.signingKeyEnvVar]));
  const readyForHostedHumanApproval =
    humanApproval.provider === "hosted" && humanApproval.brokerUrl != null;
  const readyForCustomHumanApproval =
    humanApproval.provider === "custom" &&
    humanApproval.appId != null &&
    humanApproval.rpId != null &&
    humanApprovalSigningKeyConfigured;
  const readyForHumanApproval =
    entryState.effectiveEnabled &&
    pluginConfig.hitl.enabled &&
    pluginConfig.hitl.mode === "human-approval" &&
    (readyForHostedHumanApproval || readyForCustomHumanApproval) &&
    pluginConfig.hitl.protectedTools.length > 0;

  return {
    phase: "world-agentkit",
    plugin: {
      state: pluginState,
      configured: entryState.configured,
      enabled: entryState.effectiveEnabled,
    },
    walletAddress,
    hitl: {
      enabled: pluginConfig.hitl.enabled,
      mode: pluginConfig.hitl.mode,
      resourceUrl: pluginConfig.hitl.resourceUrl,
      protectedTools: pluginConfig.hitl.protectedTools,
      grantScope: pluginConfig.hitl.grantScope,
      humanApproval: {
        provider: humanApproval.provider,
        brokerUrl: humanApproval.brokerUrl,
        appId: humanApproval.appId,
        rpId: humanApproval.rpId,
        signingKeyConfigured: humanApprovalSigningKeyConfigured,
        signingKeyEnvVar: humanApproval.signingKeyEnvVar,
        environment: humanApproval.environment,
        actionPrefix: humanApproval.actionPrefix,
      },
    },
    cli: {
      command: pluginConfig.cli.command,
      args: pluginConfig.cli.args,
      available: cliAvailable,
      resolvedPath,
    },
    checks: {
      readyForRegistration: walletAddress != null && cliAvailable,
      readyForRuntime: entryState.effectiveEnabled && walletAddress != null && cliAvailable,
      readyForHitl:
        pluginConfig.hitl.mode === "delegation"
          ? entryState.effectiveEnabled &&
            pluginConfig.hitl.enabled &&
            pluginConfig.hitl.resourceUrl != null &&
            pluginConfig.hitl.protectedTools.length > 0
          : readyForHumanApproval,
      readyForHumanApproval,
    },
    nextSteps: buildNextSteps({
      pluginState,
      hitlEnabled: pluginConfig.hitl.enabled,
      hitlMode: pluginConfig.hitl.mode,
      hitlProtectedTools: pluginConfig.hitl.protectedTools,
      hitlResourceUrl: pluginConfig.hitl.resourceUrl,
      humanApprovalBrokerUrl: humanApproval.brokerUrl,
      humanApprovalProvider: humanApproval.provider,
      humanApprovalAppId: humanApproval.appId,
      humanApprovalRpId: humanApproval.rpId,
      humanApprovalSigningKeyConfigured,
      walletAddress,
      cliCommand: pluginConfig.cli.command,
      cliAvailable,
    }),
  };
}

export function formatAgentkitStatusText(status: AgentkitStatusSnapshot): string {
  const nextSteps =
    status.nextSteps.length > 0
      ? status.nextSteps.map((step) => `- ${step}`).join("\n")
      : "- No immediate action required.";

  return [
    "AgentKit status:",
    `- phase: ${status.phase}`,
    `- plugin entry: ${formatPluginStateLabel(status.plugin.state)}`,
    `- wallet address: ${status.walletAddress ?? "not configured"}`,
    `- HITL enabled: ${status.hitl.enabled ? "yes" : "no"}`,
    `- HITL mode: ${status.hitl.mode}`,
    `- HITL resource: ${status.hitl.resourceUrl ?? "not configured"}`,
    `- HITL protected tools: ${status.hitl.protectedTools.length > 0 ? status.hitl.protectedTools.join(", ") : "none"}`,
    `- HITL grant scope: ${status.hitl.grantScope}`,
    `- World approval provider: ${status.hitl.humanApproval.provider}`,
    `- World approval broker: ${status.hitl.humanApproval.brokerUrl ?? "not configured"}`,
    `- World app ID: ${status.hitl.humanApproval.provider === "hosted" ? "provided by hosted broker" : (status.hitl.humanApproval.appId ?? "not configured")}`,
    `- World RP ID: ${status.hitl.humanApproval.provider === "hosted" ? "provided by hosted broker" : (status.hitl.humanApproval.rpId ?? "not configured")}`,
    `- World signing key: ${status.hitl.humanApproval.provider === "hosted" ? "held by hosted broker" : status.hitl.humanApproval.signingKeyConfigured ? "configured" : "not configured"}`,
    `- World environment: ${status.hitl.humanApproval.environment}`,
    `- CLI command: ${status.cli.command}`,
    `- CLI args: ${status.cli.args.length > 0 ? status.cli.args.join(" ") : "(none)"}`,
    `- CLI availability: ${status.cli.available ? `found at ${status.cli.resolvedPath}` : "not found on PATH"}`,
    `- ready for wallet registration: ${status.checks.readyForRegistration ? "yes" : "no"}`,
    `- ready for runtime delegation: ${status.checks.readyForRuntime ? "yes" : "no"}`,
    `- ready for HITL: ${status.checks.readyForHitl ? "yes" : "no"}`,
    `- ready for human approval: ${status.checks.readyForHumanApproval ? "yes" : "no"}`,
    "",
    "Next steps:",
    nextSteps,
  ].join("\n");
}
