import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";

const guardPluginConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().trim().url().optional(),
    timeoutSeconds: z.number().positive().max(30).optional(),
    failOpen: z.boolean().optional(),
    tokenEnvVar: z.string().trim().min(1).optional(),
    receiptsEnabled: z.boolean().optional(),
    painSignalsEnabled: z.boolean().optional(),
  })
  .strict();

type GuardPluginConfig = z.infer<typeof guardPluginConfigSchema>;

type GuardSettings = {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  failOpen: boolean;
  tokenEnvVar: string;
  receiptsEnabled: boolean;
  painSignalsEnabled: boolean;
};

type GuardArtifact = {
  artifactId: string;
  artifactName: string;
  artifactSlug: string;
  artifactType: string;
  harness: string;
  toolName: string;
  publisher?: string;
  domain?: string;
  launchSummary: string;
};

type GuardVerdictDecision = "allow" | "review" | "block";

type GuardPreExecutionVerdict = {
  decision: GuardVerdictDecision;
  rationale: string;
  scope: string;
};

type PendingGuardExecution = {
  artifact: GuardArtifact;
  recommendation: string;
  rationale: string;
  source: string;
};

type GuardResolutionReceipt = {
  recommendation: string;
  rationale: string;
  source: string;
};

type PluginApprovalResolution = "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled";

const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  enabled: true,
  baseUrl: "https://hol.org/api/v1/consumer",
  timeoutMs: 5_000,
  failOpen: true,
  tokenEnvVar: "OPENCLAW_GUARD_TOKEN",
  receiptsEnabled: true,
  painSignalsEnabled: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildPendingKey(
  runId: string | undefined,
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) {
    return undefined;
  }
  return runId ? `${runId}:${toolCallId}` : toolCallId;
}

function readGuardSettings(rawConfig: unknown): GuardSettings {
  const parsed = guardPluginConfigSchema.safeParse(rawConfig);
  const config: GuardPluginConfig = parsed.success ? parsed.data : {};
  return {
    enabled: config.enabled ?? DEFAULT_GUARD_SETTINGS.enabled,
    baseUrl: (config.baseUrl ?? DEFAULT_GUARD_SETTINGS.baseUrl).replace(/\/+$/, ""),
    timeoutMs: Math.round(
      (config.timeoutSeconds ?? DEFAULT_GUARD_SETTINGS.timeoutMs / 1000) * 1000,
    ),
    failOpen: config.failOpen ?? DEFAULT_GUARD_SETTINGS.failOpen,
    tokenEnvVar: config.tokenEnvVar ?? DEFAULT_GUARD_SETTINGS.tokenEnvVar,
    receiptsEnabled: config.receiptsEnabled ?? DEFAULT_GUARD_SETTINGS.receiptsEnabled,
    painSignalsEnabled: config.painSignalsEnabled ?? DEFAULT_GUARD_SETTINGS.painSignalsEnabled,
  };
}

function resolveGuardArtifact(
  toolName: string,
  params: Record<string, unknown>,
): GuardArtifact | undefined {
  const nested = isRecord(params.guardArtifact) ? params.guardArtifact : undefined;
  const source = nested ?? params;
  const fallbackName = toolName.startsWith("mcp_")
    ? toolName.slice(4).replace(/_/g, " ")
    : toolName;
  const artifactName =
    readString(source.guardArtifactName) ??
    readString(source.artifactName) ??
    readString(source.name) ??
    fallbackName;

  if (!artifactName) {
    return undefined;
  }

  const artifactType =
    readString(source.guardArtifactType) ??
    readString(source.artifactType) ??
    (toolName.startsWith("mcp_") ? "mcp-server" : "plugin");
  const artifactSlug =
    readString(source.guardArtifactSlug) ??
    readString(source.artifactSlug) ??
    slugify(artifactName);
  const artifactId =
    readString(source.guardArtifactId) ??
    readString(source.artifactId) ??
    `${artifactType}:openclaw:${artifactSlug}`;
  const publisher = readString(source.guardPublisher) ?? readString(source.publisher);
  const domain = readString(source.guardDomain) ?? readString(source.domain);
  const launchSummary =
    readString(source.guardLaunchSummary) ??
    readString(source.launchSummary) ??
    `${toolName} ${JSON.stringify(params)}`;

  return {
    artifactId,
    artifactName,
    artifactSlug,
    artifactType,
    harness: "openclaw",
    toolName,
    publisher,
    domain,
    launchSummary,
  };
}

function createAuthHeaders(settings: GuardSettings): HeadersInit | undefined {
  const token = process.env[settings.tokenEnvVar]?.trim();
  if (!token) {
    throw new Error(`Missing HOL Guard token in ${settings.tokenEnvVar}`);
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function postGuardJson(
  settings: GuardSettings,
  path: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const headers = createAuthHeaders(settings);
  const response = await fetch(`${settings.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Guard request failed: ${response.status}`);
  }
  return await response.json();
}

async function resolvePreExecutionVerdict(
  settings: GuardSettings,
  artifact: GuardArtifact,
): Promise<GuardPreExecutionVerdict | undefined> {
  const response = await postGuardJson(settings, "/verdict/pre-execution", {
    harness: artifact.harness,
    artifactId: artifact.artifactId,
    artifactName: artifact.artifactName,
    artifactSlug: artifact.artifactSlug,
    artifactType: artifact.artifactType,
    publisher: artifact.publisher,
    domain: artifact.domain,
    launchSummary: artifact.launchSummary,
  });
  if (!isRecord(response)) {
    return undefined;
  }
  const decisionRaw = readString(response.decision);
  if (!decisionRaw) {
    return undefined;
  }
  const decision = decisionRaw.toLowerCase();
  if (decision !== "allow" && decision !== "review" && decision !== "block") {
    return undefined;
  }
  return {
    decision,
    rationale: readString(response.rationale) ?? "",
    scope: readString(response.scope) ?? "guard",
  };
}

function receiptPayload(
  artifact: GuardArtifact,
  outcome: GuardResolutionReceipt,
): Record<string, unknown> {
  return {
    items: [
      {
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        artifactSlug: artifact.artifactSlug,
        artifactType: artifact.artifactType,
        harness: artifact.harness,
        summary: outcome.rationale,
        recommendation: outcome.recommendation,
        source: outcome.source,
        toolName: artifact.toolName,
      },
    ],
  };
}

async function emitReceipt(
  settings: GuardSettings,
  artifact: GuardArtifact,
  outcome: GuardResolutionReceipt,
): Promise<void> {
  if (!settings.receiptsEnabled) {
    return;
  }
  await postGuardJson(settings, "/receipts/submit", receiptPayload(artifact, outcome));
}

async function emitPainSignal(
  settings: GuardSettings,
  artifact: GuardArtifact,
  outcome: GuardResolutionReceipt,
): Promise<void> {
  if (!settings.painSignalsEnabled) {
    return;
  }
  await postGuardJson(settings, "/signals/pain", {
    items: [
      {
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        artifactSlug: artifact.artifactSlug,
        artifactType: artifact.artifactType,
        harness: artifact.harness,
        summary: outcome.rationale,
        recommendation: outcome.recommendation,
        source: outcome.source,
      },
    ],
  });
}

async function emitObservabilitySignals(
  settings: GuardSettings,
  artifact: GuardArtifact,
  outcome: GuardResolutionReceipt,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (settings.receiptsEnabled) {
    tasks.push(emitReceipt(settings, artifact, outcome));
  }
  if (settings.painSignalsEnabled) {
    tasks.push(emitPainSignal(settings, artifact, outcome));
  }
  if (tasks.length === 0) {
    return;
  }
  const results = await Promise.allSettled(tasks);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") {
    throw rejected.reason;
  }
}

function verdictSource(verdict: GuardPreExecutionVerdict): string {
  return `preexecution-${verdict.scope || "guard"}`;
}

function severityForVerdict(verdict: GuardPreExecutionVerdict): "warning" | "critical" {
  return verdict.decision === "block" ? "critical" : "warning";
}

async function settleResolution(
  settings: GuardSettings,
  artifact: GuardArtifact,
  verdict: GuardPreExecutionVerdict,
  resolution: PluginApprovalResolution,
): Promise<void> {
  if (resolution === "allow-once" || resolution === "allow-always") {
    return;
  }

  const denial: GuardResolutionReceipt = {
    recommendation: verdict.decision === "block" ? "block" : "review",
    rationale: verdict.rationale || `Guard denied ${artifact.artifactName}.`,
    source: verdictSource(verdict),
  };
  await emitObservabilitySignals(settings, artifact, denial);
}

function rememberPendingExecution(
  pendingExecutions: Map<string, PendingGuardExecution>,
  receiptsEnabled: boolean,
  runId: string | undefined,
  toolCallId: string | undefined,
  pending: PendingGuardExecution,
): void {
  if (!receiptsEnabled) {
    return;
  }
  const key = buildPendingKey(runId, toolCallId);
  if (!key) {
    return;
  }
  pendingExecutions.set(key, pending);
  if (pendingExecutions.size > 512) {
    const oldest = pendingExecutions.keys().next().value;
    if (oldest) {
      pendingExecutions.delete(oldest);
    }
  }
}

export default definePluginEntry({
  id: "hol-guard",
  name: "HOL Guard",
  description:
    "Guard cloud verdicts, approvals, receipts, and pain-signal gating for OpenClaw tool execution.",
  configSchema: buildPluginConfigSchema(guardPluginConfigSchema),
  register(api) {
    const settings = readGuardSettings(api.pluginConfig);
    const pendingExecutions = new Map<string, PendingGuardExecution>();

    api.on("before_tool_call", async (event, ctx) => {
      if (!settings.enabled) {
        return undefined;
      }
      const artifact = resolveGuardArtifact(event.toolName, event.params);
      if (!artifact) {
        return undefined;
      }

      try {
        const verdict = await resolvePreExecutionVerdict(settings, artifact);
        if (!verdict || verdict.decision === "allow") {
          rememberPendingExecution(
            pendingExecutions,
            settings.receiptsEnabled,
            ctx.runId,
            event.toolCallId,
            {
              artifact,
              recommendation: "monitor",
              rationale: verdict?.rationale || "Guard allowed tool execution.",
              source: verdict ? verdictSource(verdict) : "preexecution-guard",
            },
          );
          return undefined;
        }

        if (verdict.decision === "block") {
          const blockedOutcome = {
            recommendation: "block",
            rationale: verdict.rationale || `Guard blocked ${artifact.artifactName}.`,
            source: verdictSource(verdict),
          } satisfies GuardResolutionReceipt;
          try {
            await emitObservabilitySignals(settings, artifact, blockedOutcome);
          } catch {}
          return {
            block: true,
            blockReason: blockedOutcome.rationale,
          };
        }

        return {
          requireApproval: {
            title: `Guard review required for ${artifact.artifactName}`,
            description: verdict.rationale || `Guard requires review for ${artifact.artifactName}.`,
            severity: severityForVerdict(verdict),
            async onResolution(resolution) {
              if (resolution === "allow-once" || resolution === "allow-always") {
                rememberPendingExecution(
                  pendingExecutions,
                  settings.receiptsEnabled,
                  ctx.runId,
                  event.toolCallId,
                  {
                    artifact,
                    recommendation: "review",
                    rationale: verdict.rationale || `Guard reviewed ${artifact.artifactName}.`,
                    source: verdictSource(verdict),
                  },
                );
                return;
              }
              await settleResolution(settings, artifact, verdict, resolution);
            },
          },
        };
      } catch (error) {
        if (settings.failOpen) {
          return undefined;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          block: true,
          blockReason: `HOL Guard policy lookup failed: ${message}`,
        };
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      if (!settings.enabled || !settings.receiptsEnabled) {
        return;
      }
      const key = buildPendingKey(ctx.runId, event.toolCallId);
      if (!key) {
        return;
      }
      const pending = pendingExecutions.get(key);
      if (!pending) {
        return;
      }
      pendingExecutions.delete(key);
      const outcome: GuardResolutionReceipt = {
        recommendation: pending.recommendation,
        rationale: event.error
          ? `${pending.rationale} Execution error: ${event.error}`
          : pending.rationale,
        source: pending.source,
      };
      await emitReceipt(settings, pending.artifact, outcome);
    });
  },
});
