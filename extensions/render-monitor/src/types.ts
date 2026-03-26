import { Type } from "@sinclair/typebox";

export type RenderIncidentType =
  | "service_error"
  | "healthcheck_failed"
  | "deploy_failed"
  | "http_unavailable"
  | "crash_repeated"
  | "unknown_error";

export type RenderMonitorTelegramTarget = {
  chatId: string;
};

export type RenderMonitorGitTarget = {
  /** Local checkout path on the host where OpenClaw runs. */
  repoPath: string;
  /** GitHub repo in `owner/name` format. */
  githubRepo: string;
  /** Remote name in the git repository (default: origin). */
  remote?: string;
  /** Branch base for new remediation commits (default: main). */
  baseBranch?: string;
  /**
   * Branch to push commits to trigger Render deployments.
   * Default: `baseBranch`.
   */
  deployBranch?: string;
};

export type RenderMonitorServiceTarget = {
  serviceId: string;
  name?: string;
  environment?: string;
  publicUrl?: string;
  /**
   * Git target used for `/apply`. If omitted, remediation is disabled
   * for this service.
   */
  git?: RenderMonitorGitTarget;
};

export type RenderMonitorConfig = {
  enabled: boolean;
  pollIntervalMinutes: number;
  dedupeTtlMinutes: number;
  telegram: RenderMonitorTelegramTarget;
  renderApiKey: string;
  renderApiBaseUrl: string;
  /**
   * Probes `publicUrl` (if provided) to detect HTTP unavailability.
   * Keep disabled if you don't want active probing.
   */
  httpProbeEnabled: boolean;
  httpProbeTimeoutMs: number;
  httpProbeIntervalMinutes: number;
  services: RenderMonitorServiceTarget[];
  remediations: {
    investigationTimeoutMs: number;
    applyTimeoutMs: number;
    renderVerifyTimeoutMs: number;
    ciVerifyTimeoutMs: number;
  };
};

export type RenderMonitorConfigResolved = RenderMonitorConfig & {
  /** Derived at runtime for convenience. */
  enabledAtMs: number;
};

/** Backward-compatible alias (older code imported this name). */
export type RenderMonitorResolvedConfig = RenderMonitorConfigResolved;

export const renderMonitorConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  pollIntervalMinutes: Type.Optional(Type.Number({ default: 15 })),
  dedupeTtlMinutes: Type.Optional(Type.Number({ default: 60 })),

  /**
   * Environment variables fallback:
   * - TELEGRAM_CHAT_ID
   * - RENDER_API_KEY
   */
  telegram: Type.Optional(
    Type.Object({
      chatId: Type.Optional(Type.String()),
    }),
  ),

  services: Type.Optional(
    Type.Array(
      Type.Object({
        serviceId: Type.String(),
        name: Type.Optional(Type.String()),
        environment: Type.Optional(Type.String()),
        publicUrl: Type.Optional(Type.String()),
        git: Type.Optional(
          Type.Object({
            repoPath: Type.String(),
            githubRepo: Type.String(),
            remote: Type.Optional(Type.String()),
            baseBranch: Type.Optional(Type.String()),
            deployBranch: Type.Optional(Type.String()),
          }),
        ),
      }),
    ),
  ),

  renderApiBaseUrl: Type.Optional(Type.String({ default: "https://api.render.com" })),

  httpProbeEnabled: Type.Optional(Type.Boolean({ default: false })),
  httpProbeTimeoutMs: Type.Optional(Type.Number({ default: 8000 })),
  httpProbeIntervalMinutes: Type.Optional(Type.Number({ default: 15 })),

  remediations: Type.Optional(
    Type.Object({
      investigationTimeoutMs: Type.Optional(Type.Number({ default: 120_000 })),
      applyTimeoutMs: Type.Optional(Type.Number({ default: 10 * 60_000 })),
      renderVerifyTimeoutMs: Type.Optional(Type.Number({ default: 10 * 60_000 })),
      ciVerifyTimeoutMs: Type.Optional(Type.Number({ default: 15 * 60_000 })),
    }),
  ),
});

export type StoredRenderIncident = {
  id: string;
  fingerprint: string;
  serviceId: string;
  incidentType: RenderIncidentType;
  createdAtMs: number;
  lastDetectedAtMs: number;
  acknowledgedAtMs?: number | null;
  lastAlertedAtMs?: number | null;
  lastInvestigation?: {
    runId?: string;
    sessionKey: string;
    startedAtMs: number;
    finishedAtMs?: number | null;
    proposal?: unknown;
  } | null;

  summary: string;
  details?: Record<string, unknown>;
};

export type RenderMonitorState = {
  version: 1;
  updatedAtMs: number;
  incidentsById: Record<string, StoredRenderIncident>;
  /** Fingerprint -> incidentId (fast lookup). */
  incidentIdByFingerprint: Record<string, string>;
  /**
   * Service error streak: used to label crash repetition heuristically.
   * - We only count service_error incidents.
   */
  serviceErrorStreakByServiceId: Record<
    string,
    { count: number; lastIncidentFingerprint?: string; updatedAtMs: number }
  >;
};

export type DetectedRenderIncident = {
  incidentType: RenderIncidentType;
  fingerprint: string;
  incidentId: string;
  serviceId: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAtMs: number;
};

export type RenderServiceSnapshot = {
  serviceId: string;
  raw: Record<string, unknown>;
  status?: string | null;
  healthCheckState?: string | null;
  latestDeploy?: {
    id?: string | null;
    status?: string | null;
    // commit SHA is optional field; keep as unknown so we can store raw.
    commitSha?: string | null;
  } | null;
};

