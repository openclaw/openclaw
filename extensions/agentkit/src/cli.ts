import type { Command } from "commander";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginCliCommandDescriptor } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConfiguredAgentkitPluginConfig } from "./config.js";
import {
  filterMatchingPendingAgentkitApprovals,
  formatPendingAgentkitApprovalsText,
  listPendingAgentkitApprovals,
  resolvePendingAgentkitApproval,
  resolveRequestedAgentkitApproval,
  type AgentkitPendingApproval,
} from "./hitl-approvals.js";
import { saveAgentkitHitlGrant } from "./hitl-grants.js";
import { runAgentkitWorldHumanApproval } from "./human-approval.js";
import { resolveAgentkitHumanLookup } from "./human-lookup.js";
import {
  formatAgentkitProtectedRequestResult,
  requestAgentkitProtectedResource,
  resolveAgentkitPrivateKeyValue,
} from "./protected-request.js";
import {
  formatAgentkitRegisterPlanText,
  resolveAgentkitRegisterPlan,
  runAgentkitRegister,
} from "./register.js";
import { formatAgentkitStatusText, resolveAgentkitStatus } from "./status.js";
import {
  formatAgentkitVerifierRequestResult,
  runAgentkitVerifierRequest,
} from "./verifier-request.js";
import {
  formatAgentkitVerifierServerInfo,
  startAgentkitVerifierServer,
} from "./verifier-server.js";
import {
  formatAgentkitVerificationReport,
  resolveAgentkitHeaderValue,
  verifyAgentkitHeader,
} from "./verify.js";

export const AGENTKIT_CLI_DESCRIPTOR: OpenClawPluginCliCommandDescriptor = {
  name: "agentkit",
  description: "Inspect World AgentKit readiness, registration, and verifier flows",
  hasSubcommands: true,
};

function resolveHumanLookupModeFromResponse(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    return null;
  }
  const report = (responseBody as { report?: unknown }).report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }
  const humanLookup = (report as { humanLookup?: unknown }).humanLookup;
  if (!humanLookup || typeof humanLookup !== "object" || Array.isArray(humanLookup)) {
    return null;
  }
  return typeof (humanLookup as { mode?: unknown }).mode === "string"
    ? ((humanLookup as { mode: string }).mode ?? null)
    : null;
}

async function runAgentkitStatus(appConfig: OpenClawConfig, opts: { json?: boolean }) {
  const status = await resolveAgentkitStatus({ appConfig, env: process.env });
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(formatAgentkitStatusText(status));
}

async function runAgentkitRegisterCommand(
  appConfig: OpenClawConfig,
  opts: { dryRun?: boolean; json?: boolean; wallet?: string },
) {
  const plan = await resolveAgentkitRegisterPlan({
    appConfig,
    walletAddressOverride: opts.wallet,
  });
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (opts.dryRun) {
    console.log(formatAgentkitRegisterPlanText(plan));
    return;
  }
  console.log(formatAgentkitRegisterPlanText(plan));
  console.log("");
  console.log("Starting local AgentKit registration flow...");
  await runAgentkitRegister({ plan });
}

async function runAgentkitVerifyHeaderCommand(opts: {
  agentBookContractAddress?: string;
  agentBookRpcUrl?: string;
  header?: string;
  headerFile?: string;
  json?: boolean;
  resource: string;
  localTrustVerifiedSigner?: boolean;
}) {
  const header = await resolveAgentkitHeaderValue({
    header: opts.header,
    headerFile: opts.headerFile,
  });
  const humanLookup = resolveAgentkitHumanLookup({
    localTrustVerifiedSigner: opts.localTrustVerifiedSigner,
    agentBookContractAddress: opts.agentBookContractAddress,
    agentBookRpcUrl: opts.agentBookRpcUrl,
  });
  const report = await verifyAgentkitHeader({
    header,
    resourceUrl: opts.resource,
    agentBook: humanLookup.agentBook,
    humanLookupMode: humanLookup.humanLookupMode,
  });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatAgentkitVerificationReport(report));
}

async function runAgentkitVerifierServerCommand(opts: {
  agentBookContractAddress?: string;
  agentBookRpcUrl?: string;
  localTrustVerifiedSigner?: boolean;
  host?: string;
  port?: string;
  resourcePath?: string;
  network?: string;
  statement?: string;
}) {
  const parsedPort = opts.port ? Number.parseInt(opts.port, 10) : undefined;
  if (opts.port && Number.isNaN(parsedPort)) {
    throw new Error(`Invalid verifier server port: ${opts.port}`);
  }

  const humanLookup = resolveAgentkitHumanLookup({
    localTrustVerifiedSigner: opts.localTrustVerifiedSigner,
    agentBookContractAddress: opts.agentBookContractAddress,
    agentBookRpcUrl: opts.agentBookRpcUrl,
  });
  const handle = await startAgentkitVerifierServer({
    agentBook: humanLookup.agentBook,
    host: opts.host,
    humanLookupMode: humanLookup.humanLookupMode,
    port: parsedPort,
    resourcePath: opts.resourcePath,
    network: opts.network,
    statement: opts.statement,
  });
  console.log(formatAgentkitVerifierServerInfo(handle.info));

  const shutdown = async () => {
    await handle.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

async function runAgentkitVerifierRequestCommand(opts: {
  server: string;
  privateKey?: string;
  privateKeyFile?: string;
  json?: boolean;
}) {
  const privateKey = await resolveAgentkitPrivateKeyValue({
    privateKey: opts.privateKey,
    privateKeyFile: opts.privateKeyFile,
  });
  const result = await runAgentkitVerifierRequest({
    serverOrigin: opts.server,
    privateKey,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatAgentkitVerifierRequestResult(result));
}

async function runAgentkitProtectedRequestCommand(opts: {
  resource: string;
  privateKey?: string;
  privateKeyFile?: string;
  json?: boolean;
}) {
  const privateKey = await resolveAgentkitPrivateKeyValue({
    privateKey: opts.privateKey,
    privateKeyFile: opts.privateKeyFile,
  });
  const result = await requestAgentkitProtectedResource({
    resourceUrl: opts.resource,
    privateKey,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatAgentkitProtectedRequestResult(result));
}

async function runAgentkitApprovalsCommand(
  appConfig: OpenClawConfig,
  opts: { gatewayUrl?: string; json?: boolean },
) {
  const approvals = await listPendingAgentkitApprovals({
    appConfig,
    gatewayUrl: opts.gatewayUrl,
  });
  if (opts.json) {
    console.log(JSON.stringify(approvals, null, 2));
    return;
  }
  console.log(formatPendingAgentkitApprovalsText(approvals));
}

async function resolveMatchingCliApprovals(params: {
  appConfig: OpenClawConfig;
  approvals: AgentkitPendingApproval[];
  approval: AgentkitPendingApproval;
  gatewayUrl?: string;
  pluginConfig: ReturnType<typeof resolveConfiguredAgentkitPluginConfig>;
}): Promise<{ failed: number; resolved: number }> {
  const matching = filterMatchingPendingAgentkitApprovals({
    approvals: params.approvals,
    approval: params.approval,
    pluginConfig: params.pluginConfig,
  });
  let failed = 0;
  await Promise.all(
    matching.map(async (approval) => {
      try {
        await resolvePendingAgentkitApproval({
          appConfig: params.appConfig,
          approvalId: approval.id,
          decision: "allow-always",
          gatewayUrl: params.gatewayUrl,
        });
      } catch {
        failed += 1;
      }
    }),
  );
  return { failed, resolved: matching.length - failed };
}

async function runAgentkitApproveCommand(
  appConfig: OpenClawConfig,
  opts: {
    approvalId?: string;
    decision?: ExecApprovalDecision;
    gatewayUrl?: string;
    json?: boolean;
    privateKey?: string;
    privateKeyFile?: string;
    resource?: string;
  },
) {
  const pluginConfig = resolveConfiguredAgentkitPluginConfig(appConfig);
  const approvals = await listPendingAgentkitApprovals({
    appConfig,
    gatewayUrl: opts.gatewayUrl,
  });
  const approval = resolveRequestedAgentkitApproval({
    approvals,
    approvalId: opts.approvalId,
  });
  const rawDecision = opts.decision ?? "allow-once";
  if (rawDecision !== "allow-once" && rawDecision !== "allow-always" && rawDecision !== "deny") {
    throw new Error(
      `Invalid AgentKit approval decision: ${String(rawDecision)}. Use allow-once, allow-always, or deny.`,
    );
  }
  const decision = rawDecision;
  const canPersistGrant =
    pluginConfig.hitl.grantScope === "agent"
      ? approval.request.agentId != null
      : approval.request.sessionKey != null;
  const shouldPersistGrant = decision === "allow-always" && canPersistGrant;

  if (decision === "deny") {
    await resolvePendingAgentkitApproval({
      appConfig,
      approvalId: approval.id,
      decision,
      gatewayUrl: opts.gatewayUrl,
    });
    const payload = {
      status: "resolved",
      approvalId: approval.id,
      decision,
      mode: pluginConfig.hitl.mode,
      grantStored: false,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload));
      return;
    }
    console.log("AgentKit approval resolved");
    console.log(`- approval id: ${payload.approvalId}`);
    console.log(`- decision: ${payload.decision}`);
    console.log(`- mode: ${payload.mode}`);
    console.log("- delegation grant stored: no");
    return;
  }

  if (pluginConfig.hitl.mode === "human-approval") {
    if (opts.privateKey || opts.privateKeyFile) {
      throw new Error(
        "Private key options are only valid in delegation mode. Human approval mode uses a World ID QR/link instead.",
      );
    }
    const approvalResult = await runAgentkitWorldHumanApproval({
      approval,
      pluginConfig,
      env: process.env,
      logLine: opts.json ? () => {} : console.log,
      onPending: opts.json
        ? (session) => {
            console.log(
              JSON.stringify({
                status: "pending",
                approvalId: approval.id,
                decision,
                mode: pluginConfig.hitl.mode,
                connectorURI: session.connectorURI,
                requestId: session.requestId,
                action: session.action,
              }),
            );
          }
        : undefined,
      renderQrCode: opts.json ? async () => {} : undefined,
      timeoutMs: pluginConfig.hitl.timeoutMs,
    });
    if (!approvalResult.success) {
      const code = approvalResult.errorCode
        ? `World approval did not complete successfully (${approvalResult.errorCode}).`
        : `World approval verification failed with status ${approvalResult.verifyStatus}.`;
      throw new Error(`${code} The pending OpenClaw approval was left unresolved.`);
    }

    await resolvePendingAgentkitApproval({
      appConfig,
      approvalId: approval.id,
      decision,
      gatewayUrl: opts.gatewayUrl,
    });
    const matchingResolution = shouldPersistGrant
      ? await resolveMatchingCliApprovals({
          appConfig,
          approvals,
          approval,
          gatewayUrl: opts.gatewayUrl,
          pluginConfig,
        })
      : { failed: 0, resolved: 0 };
    if (shouldPersistGrant) {
      const nowMs = Date.now();
      saveAgentkitHitlGrant({
        appConfig,
        pluginConfig,
        grant: {
          id: `${approval.id}:${decision}`,
          approvalMode: "human-approval",
          resourceUrl: null,
          decision,
          scope: {
            toolName: approval.request.toolName ?? "unknown",
            sessionKey: approval.request.sessionKey,
            agentId: approval.request.agentId,
          },
          humanLookupMode: "world-id",
          signerAddress: null,
          proofNullifier: approvalResult.nullifier,
          grantedAtMs: nowMs,
          expiresAtMs: decision === "allow-always" ? nowMs + pluginConfig.hitl.grantTtlMs : null,
          consumedAtMs: null,
        },
      });
    }

    const payload = {
      status: "resolved",
      approvalId: approval.id,
      decision,
      mode: pluginConfig.hitl.mode,
      connectorURI: approvalResult.connectorURI,
      requestId: approvalResult.requestId,
      action: approvalResult.action,
      verifyStatus: approvalResult.verifyStatus,
      grantStored: shouldPersistGrant,
      matchingApprovalsResolved: matchingResolution.resolved,
      matchingApprovalsFailed: matchingResolution.failed,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload));
      return;
    }
    console.log("AgentKit approval resolved");
    console.log(`- approval id: ${payload.approvalId}`);
    console.log(`- decision: ${payload.decision}`);
    console.log(`- mode: ${payload.mode}`);
    console.log(`- world request id: ${payload.requestId}`);
    console.log(`- verification status: ${payload.verifyStatus}`);
    console.log(`- delegation grant stored: ${payload.grantStored ? "yes" : "no"}`);
    if (payload.matchingApprovalsResolved > 0 || payload.matchingApprovalsFailed > 0) {
      console.log(`- matching approvals resolved: ${payload.matchingApprovalsResolved}`);
      console.log(`- matching approvals failed: ${payload.matchingApprovalsFailed}`);
    }
    return;
  }

  const privateKey = await resolveAgentkitPrivateKeyValue({
    privateKey: opts.privateKey,
    privateKeyFile: opts.privateKeyFile,
  });
  const resourceUrl = opts.resource ?? pluginConfig.hitl.resourceUrl;
  if (!resourceUrl) {
    throw new Error(
      "AgentKit approval resource URL is not configured. Set plugins.entries.agentkit.config.hitl.resourceUrl or pass --resource <url>.",
    );
  }
  const protectedRequest = await requestAgentkitProtectedResource({
    resourceUrl,
    privateKey,
  });
  if (protectedRequest.finalStatus !== 200) {
    throw new Error(
      `AgentKit proof-backed request failed with status ${protectedRequest.finalStatus}; approval was not resolved.`,
    );
  }
  await resolvePendingAgentkitApproval({
    appConfig,
    approvalId: approval.id,
    decision,
    gatewayUrl: opts.gatewayUrl,
  });
  const matchingResolution = shouldPersistGrant
    ? await resolveMatchingCliApprovals({
        appConfig,
        approvals,
        approval,
        gatewayUrl: opts.gatewayUrl,
        pluginConfig,
      })
    : { failed: 0, resolved: 0 };
  if (shouldPersistGrant) {
    const nowMs = Date.now();
    saveAgentkitHitlGrant({
      appConfig,
      pluginConfig,
      grant: {
        id: `${approval.id}:${decision}`,
        approvalMode: "delegation",
        resourceUrl,
        decision,
        scope: {
          toolName: approval.request.toolName ?? "unknown",
          sessionKey: approval.request.sessionKey,
          agentId: approval.request.agentId,
        },
        humanLookupMode: resolveHumanLookupModeFromResponse(protectedRequest.responseBody),
        signerAddress: protectedRequest.signerAddress,
        proofNullifier: null,
        grantedAtMs: nowMs,
        expiresAtMs: decision === "allow-always" ? nowMs + pluginConfig.hitl.grantTtlMs : null,
        consumedAtMs: null,
      },
    });
  }

  const payload = {
    approvalId: approval.id,
    decision,
    mode: pluginConfig.hitl.mode,
    resourceUrl,
    signerAddress: protectedRequest.signerAddress,
    finalStatus: protectedRequest.finalStatus,
    grantStored: shouldPersistGrant,
    matchingApprovalsResolved: matchingResolution.resolved,
    matchingApprovalsFailed: matchingResolution.failed,
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("AgentKit approval resolved");
  console.log(`- approval id: ${payload.approvalId}`);
  console.log(`- decision: ${payload.decision}`);
  console.log(`- mode: ${payload.mode}`);
  console.log(`- protected resource: ${payload.resourceUrl}`);
  console.log(`- signer address: ${payload.signerAddress}`);
  console.log(`- delegation grant stored: ${payload.grantStored ? "yes" : "no"}`);
  if (payload.matchingApprovalsResolved > 0 || payload.matchingApprovalsFailed > 0) {
    console.log(`- matching approvals resolved: ${payload.matchingApprovalsResolved}`);
    console.log(`- matching approvals failed: ${payload.matchingApprovalsFailed}`);
  }
}

export function registerAgentkitCli(program: Command, appConfig: OpenClawConfig) {
  const agentkit = program
    .command("agentkit")
    .description("Inspect World AgentKit readiness, registration, and verifier flows");

  agentkit
    .command("status")
    .description("Show AgentKit registration and HITL readiness")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      await runAgentkitStatus(appConfig, opts);
    });

  agentkit
    .command("register")
    .description("Start the local AgentKit wallet registration flow")
    .option("--wallet <address>", "Override the configured wallet address")
    .option("--dry-run", "Print the resolved registration invocation without running it")
    .option("--json", "Print the resolved registration plan as JSON")
    .action(async (opts: { dryRun?: boolean; json?: boolean; wallet?: string }) => {
      await runAgentkitRegisterCommand(appConfig, opts);
    });

  agentkit
    .command("approvals")
    .description("List pending AgentKit-backed OpenClaw plugin approvals")
    .option("--gateway-url <url>", "Override the gateway URL used for approval lookup")
    .option("--json", "Print JSON")
    .action(async (opts: { gatewayUrl?: string; json?: boolean }) => {
      await runAgentkitApprovalsCommand(appConfig, opts);
    });

  agentkit
    .command("approve")
    .description(
      "Resolve a pending AgentKit plugin approval using either delegation mode or a World QR approval flow",
    )
    .option("--approval-id <id>", "Specific pending AgentKit approval id to resolve")
    .option("--resource <url>", "Protected resource URL to verify before resolving approval")
    .option("--private-key <hex>", "Use a specific EVM private key instead of generating one")
    .option("--private-key-file <path>", "Read the private key from a file or `-` for stdin")
    .option("--gateway-url <url>", "Override the gateway URL used for approval resolution")
    .option(
      "--decision <decision>",
      "Approval decision to apply after proof verification (allow-once|allow-always|deny)",
      "allow-once",
    )
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        approvalId?: string;
        decision?: ExecApprovalDecision;
        gatewayUrl?: string;
        json?: boolean;
        privateKey?: string;
        privateKeyFile?: string;
        resource?: string;
      }) => {
        await runAgentkitApproveCommand(appConfig, opts);
      },
    );

  agentkit
    .command("verify-header")
    .description("Verify an AgentKit header against a protected resource URL")
    .requiredOption("--resource <url>", "The protected resource URL the header should authorize")
    .option(
      "--agentbook-rpc-url <url>",
      "Override the World Chain RPC URL used for AgentBook lookups",
    )
    .option(
      "--agentbook-contract-address <address>",
      "Override the AgentBook contract address used for human lookups",
    )
    .option("--header <value>", "Provide the base64 AgentKit header inline")
    .option("--header-file <path>", "Read the base64 AgentKit header from a file or `-` for stdin")
    .option(
      "--local-trust-verified-signer",
      "Treat any valid signature as human-backed for local verifier checks",
    )
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        agentBookContractAddress?: string;
        agentBookRpcUrl?: string;
        header?: string;
        headerFile?: string;
        json?: boolean;
        resource: string;
        localTrustVerifiedSigner?: boolean;
      }) => {
        await runAgentkitVerifyHeaderCommand(opts);
      },
    );

  agentkit
    .command("verifier-server")
    .description("Run a local AgentKit-protected verifier resource on loopback")
    .option(
      "--agentbook-rpc-url <url>",
      "Override the World Chain RPC URL used for AgentBook lookups",
    )
    .option(
      "--agentbook-contract-address <address>",
      "Override the AgentBook contract address used for human lookups",
    )
    .option(
      "--local-trust-verified-signer",
      "Treat any valid signature as human-backed instead of using the real AgentBook verifier",
    )
    .option("--host <host>", "Loopback host to bind", "127.0.0.1")
    .option("--port <port>", "TCP port to bind (default: random free port)")
    .option("--resource-path <path>", "Protected resource path", "/protected")
    .option("--network <chainId>", "AgentKit network to advertise", "eip155:480")
    .option(
      "--statement <text>",
      "Custom SIWE statement for the protected-resource challenge",
      "Sign in to access the OpenClaw AgentKit protected resource.",
    )
    .action(
      async (opts: {
        agentBookContractAddress?: string;
        agentBookRpcUrl?: string;
        localTrustVerifiedSigner?: boolean;
        host?: string;
        port?: string;
        resourcePath?: string;
        network?: string;
        statement?: string;
      }) => {
        await runAgentkitVerifierServerCommand(opts);
      },
    );

  agentkit
    .command("verifier-request")
    .description("Fetch a verifier challenge, sign it locally, and request the protected resource")
    .requiredOption("--server <url>", "Verifier server origin, for example http://127.0.0.1:4123")
    .option("--private-key <hex>", "Reuse a specific private key instead of generating one")
    .option("--private-key-file <path>", "Read the private key from a file or `-` for stdin")
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        server: string;
        privateKey?: string;
        privateKeyFile?: string;
        json?: boolean;
      }) => {
        await runAgentkitVerifierRequestCommand(opts);
      },
    );

  agentkit
    .command("request")
    .description(
      "Request an AgentKit-protected resource by fetching a challenge and attaching a signed header",
    )
    .requiredOption("--resource <url>", "Protected resource URL")
    .option("--private-key <hex>", "Use a specific EVM private key instead of generating one")
    .option("--private-key-file <path>", "Read the private key from a file or `-` for stdin")
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        resource: string;
        privateKey?: string;
        privateKeyFile?: string;
        json?: boolean;
      }) => {
        await runAgentkitProtectedRequestCommand(opts);
      },
    );
}

export const __testing = {
  runAgentkitApproveCommand,
};
