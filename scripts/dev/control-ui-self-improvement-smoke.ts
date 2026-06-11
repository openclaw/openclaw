import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type {
  SelfImprovementAuditEvent,
  SelfImprovementOperationalHealthSnapshot,
  SelfImprovementProposal,
  SelfImprovementRecommendation,
} from "../../src/self-improvement/types.js";
import {
  appendControlUiTokenFragment,
  redactControlUiSmokeSecrets,
} from "./control-ui-smoke-url.js";

type GatewayInstance = {
  artifactDir: string;
  child: ChildProcessWithoutNullStreams;
  configPath: string;
  port: number;
  stateDir: string;
  stderr: string[];
  stdout: string[];
  stop: () => Promise<void>;
  token: string;
  url: string;
};

type SelfImprovementSmokeSnapshot = {
  activeRecommendations: number;
  auditEvents: number;
  bodyText: string;
  groups: number;
  lastAnalysis: {
    attempts: number;
    groupsAnalyzed: number;
    mode: string;
    schemaValidated: boolean;
  } | null;
  lastModelPreflight: {
    attempts: number;
    preflightStatus: string;
    ready: boolean;
    readiness: string;
    readyModelId: string;
    readyTier: string;
    reviewPolicy: string;
  } | null;
  phase: string;
  proposals: number;
};

type SelfImprovementSmokeSummary = {
  artifactDir: string;
  authUrlClean: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  responseErrors: string[];
  screenshots: string[];
  seededRecommendationId: string;
  snapshots: SelfImprovementSmokeSnapshot[];
  stateDir: string;
  url: string;
  ok: true;
};

type ModelPreflightUiState = {
  error: string | null;
  loading: boolean | null;
  lastModelPreflight: {
    attempts: number;
    preflightStatus: string;
    ready: boolean;
    readiness: string;
    readyModelId: string;
    readyTier: string;
    reviewPolicy: string;
  } | null;
};

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactSmokeSecrets(value: string): string {
  return redactControlUiSmokeSecrets(value);
}

function localChromeCandidates(): string[] {
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform() === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

function resolveBrowserExecutable(): string | undefined {
  const explicit = process.env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER?.trim();
  if (explicit) {
    return explicit;
  }
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) {
    return bundled;
  }
  return localChromeCandidates().find((candidate) => existsSync(candidate));
}

function resolveGatewayEntrypoint(): string {
  if (existsSync("dist/index.js")) {
    return "dist/index.js";
  }
  if (existsSync("dist/index.mjs")) {
    return "dist/index.mjs";
  }
  return "scripts/run-node.mjs";
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve an ephemeral loopback port");
  }
  return address.port;
}

async function waitForPortOpen(params: {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.child.exitCode !== null) {
      throw new Error(
        `Gateway exited before listening (code=${String(params.child.exitCode)}):\n${formatLogs(
          params.stdout,
          params.stderr,
        )}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: params.port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `Timed out waiting for isolated Gateway on ${params.port}:\n${formatLogs(
      params.stdout,
      params.stderr,
    )}`,
  );
}

function formatLogs(stdout: string[], stderr: string[]): string {
  return `--- stdout ---\n${redactSmokeSecrets(stdout.join(""))}\n--- stderr ---\n${redactSmokeSecrets(
    stderr.join(""),
  )}`;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  return await Promise.race([
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      child.once("exit", () => resolve(true));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export function buildSelfImprovementSmokeConfig(params: {
  port: number;
  token: string;
}): OpenClawConfig {
  return {
    gateway: {
      port: params.port,
      bind: "loopback",
      auth: { mode: "token", token: params.token },
      controlUi: { enabled: true },
    },
    hooks: { enabled: false },
  };
}

export function buildSeedRecommendation(now: number): SelfImprovementRecommendation {
  return {
    id: "sir_self_improvement_dashboard_smoke",
    fingerprint: "dashboard-smoke:self-improvement:seeded-verification-gap",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "open",
    title: "Seeded dashboard smoke verification gap",
    summary: "Seeded recommendation used only by the isolated Self-Improvement dashboard smoke.",
    category: "verification_gap",
    severity: "high",
    criticality: "high",
    priority: "high",
    impact: "high",
    effort: "small",
    confidence: 0.91,
    groupKey: "verification_gap:dashboard-smoke:self-improvement",
    groupTitle: "Self-Improvement dashboard cards need live smoke proof",
    recurrenceCount: 1,
    source: {
      kind: "configuration",
      label: "Self-Improvement dashboard smoke fixture",
    },
    route: {
      role: "qa",
      targetAgentId: "qa-test-agent",
      targetAgentLabel: "QA Test Agent",
      reason: "Verification gap, smoke failure, or test-proof follow-up.",
    },
    recommendedAction:
      "Confirm the Self-Improvement dashboard renders the recommendation card, scorecard, proposals, and deterministic analysis metadata.",
    requiredEvidence: [
      "Self-Improvement Recommendations heading rendered.",
      "Last analysis metadata rendered after a deterministic analysis run.",
      "Proposal Queue rendered from the seeded recommendation.",
    ],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: true,
      requiresTests: true,
      blockedActions: [
        "no direct merge",
        "no push",
        "no release",
        "no destructive file actions",
        "no uncontrolled skill writes",
      ],
    },
    analysis: {
      mode: "deterministic",
      summary: "One seeded recommendation is ready for routed QA review.",
      generatedAt: now,
      confidence: 0.91,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 3,
      safetyNotes: [
        "Recommendation-only; the governor does not merge, push, release, or write skills.",
        "Resolution should include test or smoke proof.",
      ],
    },
    evidence: [
      "Dashboard smoke fixture: recommendation card should render.",
      "Dashboard smoke fixture: analysis metadata should render.",
      "Dashboard smoke fixture: proposal queue should render.",
    ],
  };
}

export function buildSeedIntelligenceRecommendation(now: number): SelfImprovementRecommendation {
  return {
    id: "sir_self_improvement_intelligence_smoke",
    fingerprint: "dashboard-smoke:self-improvement:seeded-workflow-simplification",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "open",
    title: "Seeded workflow simplification opportunity",
    summary:
      "Seeded recommendation used only to verify the Self-Improvement Improvement Intelligence cards.",
    category: "workflow_simplification",
    severity: "medium",
    criticality: "medium",
    priority: "medium",
    impact: "medium",
    effort: "small",
    confidence: 0.88,
    groupKey: "workflow_simplification:dashboard-smoke:self-improvement",
    groupTitle: "Self-Improvement dashboard workflow simplification signal",
    recurrenceCount: 1,
    source: {
      kind: "workflow",
      label: "Self-Improvement dashboard smoke fixture",
    },
    route: {
      role: "program_manager",
      targetAgentId: "program-manager",
      targetAgentLabel: "Program Manager",
      reason: "Sequencing, stale work triage, and priority coordination.",
    },
    recommendedAction:
      "Confirm the Self-Improvement dashboard renders Improvement Intelligence without authorizing implementation work.",
    requiredEvidence: [
      "Improvement Intelligence heading rendered.",
      "Seeded workflow simplification opportunity rendered.",
    ],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: true,
      requiresTests: false,
      blockedActions: [
        "no direct merge",
        "no push",
        "no release",
        "no destructive file actions",
        "no uncontrolled skill writes",
      ],
    },
    analysis: {
      mode: "deterministic",
      summary: "One seeded workflow simplification recommendation is ready for routed review.",
      generatedAt: now,
      confidence: 0.88,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 2,
      safetyNotes: [
        "Recommendation-only; the governor does not merge, push, release, or write skills.",
        "Tests are required if follow-up changes code or config.",
      ],
    },
    evidence: [
      "Dashboard smoke fixture: Improvement Intelligence should render.",
      "Dashboard smoke fixture: no direct implementation action should run.",
    ],
  };
}

export function buildSeedAuditEvent(now: number): SelfImprovementAuditEvent {
  return {
    id: "sie_self_improvement_dashboard_smoke",
    createdAt: now,
    kind: "model_preflight",
    actor: "gateway",
    targetId: "self-improvement-models",
    summary: "Checked Self-Improvement model readiness: degraded.",
    metadata: {
      reviewPolicy: "local_first",
      readiness: "degraded",
      ready: true,
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      reviewModelId: "ollama/qwen3.6:27b-q8_0",
      fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      preflightStatus: "missing_config",
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
      primaryRemediationHint:
        "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
    },
  };
}

export function buildSeedCuratorProposal(now: number): SelfImprovementProposal {
  return {
    id: "sip_self_improvement_memory_skill_smoke",
    createdAt: now,
    updatedAt: now,
    status: "pending",
    kind: "memory_skill",
    groupId: "sig_self_improvement_memory_skill_smoke",
    groupKey: "knowledge_hygiene:dashboard-smoke:self-improvement",
    title: "Pending memory/skill proposal: dashboard smoke curation",
    summary: "Seeded memory/skill proposal used only to verify the Self-Improvement curator queue.",
    route: {
      role: "memory_curator",
      targetAgentId: "memory-knowledge-curator",
      targetAgentLabel: "Memory/Knowledge Curator",
      reason: "Memory or Skill Workshop proposal review.",
    },
    sourceRecommendationIds: ["sir_self_improvement_dashboard_smoke"],
    recommendedAction:
      "Keep this proposal in pending mode until an operator links a Skill Workshop proposal.",
    requiredEvidence: ["Memory/Skill Curator Queue rendered in the Control UI smoke."],
    safetyNotes: [
      "No uncontrolled memory or skill writes.",
      "Skill Workshop linkage must remain pending until operator approval.",
    ],
    approvalRequired: true,
    testsRequired: false,
    analysisMode: "deterministic",
    curatorStatus: "accepted_for_workshop",
    curatorProof: "Seeded proof that the fixture is recommendation-only.",
  };
}

export function buildSeedReviewerEvalAuditEvent(now: number): SelfImprovementAuditEvent {
  return {
    id: "sie_self_improvement_reviewer_eval_smoke",
    createdAt: now + 1,
    kind: "reviewer_eval_run",
    actor: "governor",
    targetId: "self-improvement-reviewer",
    summary: "Ran Self-Improvement reviewer evals: ready.",
    metadata: {
      promptVersion: "self-improvement-governor-reviewer-evals-v1",
      fixtureSet: "smoke",
      readiness: "ready",
      ready: true,
      reviewPolicy: "local_first",
      localFirst: true,
      schemaValidated: true,
      casesTotal: 3,
      casesPassed: 3,
      passRate: 1,
      schemaValidRate: 1,
      safetyPassRate: 1,
      routePreservationRate: 1,
      p95CompletionMs: 4321,
      modelId: "ollama/qwen3.6:27b-q8_0",
      modelTier: "primaryReview",
      diagnostics: [],
    },
  };
}

export function buildSeedBackgroundCycleAuditEvent(now: number): SelfImprovementAuditEvent {
  return {
    id: "sie_self_improvement_background_cycle_smoke",
    createdAt: now + 2,
    kind: "background_cycle",
    actor: "governor",
    targetId: "self-improvement-background",
    summary: "Completed Self-Improvement background cycle.",
    metadata: {
      success: true,
      analysisLimit: 25,
    },
  };
}

export function buildSeedOperationalHealthSnapshot(
  now: number,
): SelfImprovementOperationalHealthSnapshot {
  return {
    id: "sih_self_improvement_smoke",
    createdAt: now + 3,
    health: {
      generatedAt: now + 3,
      status: "degraded",
      score: 78,
      trend: "stable",
      intervalMs: 21_600_000,
      staleAfterMs: 43_200_000,
      dimensions: [
        {
          id: "models",
          label: "Model readiness",
          status: "degraded",
          score: 74,
          summary: "Latest model preflight is degraded.",
          metrics: [{ key: "stale", label: "Stale", value: false }],
          blockers: ["Latest model preflight is degraded."],
          nextActions: ["Run preflight and fix blocked local model paths."],
        },
        {
          id: "background",
          label: "Background cadence",
          status: "ready",
          score: 100,
          summary: "Latest cycle signal is fresh.",
          metrics: [{ key: "hasCycleSignal", label: "Cycle signal exists", value: true }],
          blockers: [],
          nextActions: ["Keep the Gateway running so idle review cycles continue."],
        },
        {
          id: "intelligence",
          label: "Improvement intelligence",
          status: "degraded",
          score: 82,
          summary: "Continuous-improvement opportunities need triage or measurement.",
          metrics: [{ key: "intelligenceTotal", label: "Total", value: 1 }],
          blockers: ["1 workflow simplification opportunity is active."],
          nextActions: ["Review Improvement Intelligence."],
        },
      ],
      blockers: ["Latest model preflight is degraded."],
      nextActions: ["Run preflight and fix blocked local model paths."],
      latestReviewerEvalAt: now + 1,
      latestModelPreflightAt: now,
      latestBackgroundAt: now + 2,
    },
  };
}

export function buildSeedOperationalHealthAuditEvent(now: number): SelfImprovementAuditEvent {
  return {
    id: "sie_self_improvement_health_smoke",
    createdAt: now + 3,
    kind: "operational_health_snapshot",
    actor: "governor",
    targetId: "self-improvement-health",
    summary: "Recorded Self-Improvement operational health: degraded.",
    metadata: {
      status: "degraded",
      score: 78,
      trend: "stable",
      dimensionStatus: ["models:degraded:74", "background:ready:100"],
      blockers: ["Latest model preflight is degraded."],
    },
  };
}

export async function seedSelfImprovementSmokeState(params: {
  now: number;
  stateDir: string;
}): Promise<SelfImprovementRecommendation> {
  const recommendation = buildSeedRecommendation(params.now);
  const intelligenceRecommendation = buildSeedIntelligenceRecommendation(params.now);
  const auditEvent = buildSeedAuditEvent(params.now);
  const reviewerEvalAuditEvent = buildSeedReviewerEvalAuditEvent(params.now);
  const backgroundCycleAuditEvent = buildSeedBackgroundCycleAuditEvent(params.now);
  const healthAuditEvent = buildSeedOperationalHealthAuditEvent(params.now);
  const healthSnapshot = buildSeedOperationalHealthSnapshot(params.now);
  const curatorProposal = buildSeedCuratorProposal(params.now);
  const storeDir = join(params.stateDir, "self-improvement");
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    join(storeDir, "recommendations.json"),
    `${JSON.stringify(
      { version: 2, recommendations: [recommendation, intelligenceRecommendation] },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    join(storeDir, "audit-events.json"),
    `${JSON.stringify(
      {
        version: 1,
        events: [auditEvent, reviewerEvalAuditEvent, backgroundCycleAuditEvent, healthAuditEvent],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    join(storeDir, "proposals.json"),
    `${JSON.stringify({ version: 1, proposals: [curatorProposal] }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    join(storeDir, "health-snapshots.json"),
    `${JSON.stringify({ version: 1, snapshots: [healthSnapshot] }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return recommendation;
}

async function startIsolatedGateway(artifactDir: string): Promise<GatewayInstance> {
  const port = await getFreePort();
  const token = `self-improvement-smoke-${randomUUID()}`;
  const homeDir = join(artifactDir, "home");
  const stateDir = join(homeDir, ".openclaw");
  const configPath = join(stateDir, "openclaw.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    configPath,
    `${JSON.stringify(buildSelfImprovementSmokeConfig({ port, token }), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await seedSelfImprovementSmokeState({ now: Date.now(), stateDir });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const entrypoint = resolveGatewayEntrypoint();
  const child = spawn(
    "node",
    [entrypoint, "gateway", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_PASSWORD: "",
        OPENCLAW_GATEWAY_TOKEN: "",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  await waitForPortOpen({ child, port, stdout, stderr, timeoutMs: 90_000 });

  return {
    artifactDir,
    child,
    configPath,
    port,
    stateDir,
    stderr,
    stdout,
    token,
    url: `http://127.0.0.1:${port}/agents`,
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
      const stopped = await waitForExit(child, 2_000);
      if (!stopped && child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
    },
  };
}

async function waitForAgentsTab(page: Page) {
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { connected?: boolean; tab?: string })
        | null;
      return app?.connected === true && app.tab === "agents";
    },
    null,
    { timeout: 45_000 },
  );
}

async function snapshotSelfImprovement(
  page: Page,
  phase: string,
): Promise<SelfImprovementSmokeSnapshot> {
  return await page.evaluate((phaseName) => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          selfImprovementGroups?: unknown[];
          selfImprovementAuditEvents?: unknown[];
          selfImprovementLastAnalysis?: {
            attempts?: unknown[];
            groupsAnalyzed?: number;
            mode?: string;
            schemaValidated?: boolean;
          } | null;
          selfImprovementLastModelPreflight?: {
            attempts?: unknown[];
            preflightStatus?: string;
            ready?: boolean;
            readiness?: string;
            readyModelId?: string;
            readyTier?: string;
            reviewPolicy?: string;
          } | null;
          selfImprovementProposals?: unknown[];
          selfImprovementTotal?: number;
        })
      | null;
    const analysis = app?.selfImprovementLastAnalysis ?? null;
    const modelPreflight = app?.selfImprovementLastModelPreflight ?? null;
    return {
      activeRecommendations: app?.selfImprovementTotal ?? 0,
      auditEvents: app?.selfImprovementAuditEvents?.length ?? 0,
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1600),
      groups: app?.selfImprovementGroups?.length ?? 0,
      lastAnalysis: analysis
        ? {
            attempts: analysis.attempts?.length ?? 0,
            groupsAnalyzed: analysis.groupsAnalyzed ?? 0,
            mode: analysis.mode ?? "",
            schemaValidated: analysis.schemaValidated === true,
          }
        : null,
      lastModelPreflight: modelPreflight
        ? {
            attempts: modelPreflight.attempts?.length ?? 0,
            preflightStatus: modelPreflight.preflightStatus ?? "",
            ready: modelPreflight.ready === true,
            readiness: modelPreflight.readiness ?? "",
            readyModelId: modelPreflight.readyModelId ?? "",
            readyTier: modelPreflight.readyTier ?? "",
            reviewPolicy: modelPreflight.reviewPolicy ?? "",
          }
        : null,
      phase: phaseName,
      proposals: app?.selfImprovementProposals?.length ?? 0,
    } satisfies SelfImprovementSmokeSnapshot;
  }, phase);
}

async function readModelPreflightUiState(page: Page): Promise<ModelPreflightUiState> {
  return await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          selfImprovementError?: string | null;
          selfImprovementLastModelPreflight?: {
            attempts?: unknown[];
            preflightStatus?: string;
            ready?: boolean;
            readiness?: string;
            readyModelId?: string;
            readyTier?: string;
            reviewPolicy?: string;
          } | null;
          selfImprovementModelPreflightLoading?: boolean;
        })
      | null;
    const preflight = app?.selfImprovementLastModelPreflight ?? null;
    return {
      error: app?.selfImprovementError ?? null,
      loading: app?.selfImprovementModelPreflightLoading ?? null,
      lastModelPreflight: preflight
        ? {
            attempts: preflight.attempts?.length ?? 0,
            preflightStatus: preflight.preflightStatus ?? "",
            ready: preflight.ready === true,
            readiness: preflight.readiness ?? "",
            readyModelId: preflight.readyModelId ?? "",
            readyTier: preflight.readyTier ?? "",
            reviewPolicy: preflight.reviewPolicy ?? "",
          }
        : null,
    } satisfies ModelPreflightUiState;
  });
}

async function runSelfImprovementFlow(page: Page, artifactDir: string) {
  const screenshots: string[] = [];
  const snapshots: SelfImprovementSmokeSnapshot[] = [];
  await waitForAgentsTab(page);
  const tab = page.locator("button.agent-tab", { hasText: "Self-Improvement" });
  await tab.first().click({ timeout: 20_000 });
  await page.getByRole("heading", { name: "Self-Improvement Recommendations" }).waitFor({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            selfImprovementAuditEvents?: unknown[];
            selfImprovementGroups?: unknown[];
            selfImprovementHealth?: unknown;
            selfImprovementLoading?: boolean;
            selfImprovementTotal?: number;
          })
        | null;
      return (
        app?.selfImprovementLoading === false &&
        (app.selfImprovementTotal ?? 0) > 0 &&
        (app.selfImprovementGroups?.length ?? 0) > 0 &&
        (app.selfImprovementAuditEvents?.length ?? 0) > 0 &&
        Boolean(app.selfImprovementHealth)
      );
    },
    null,
    { timeout: 30_000 },
  );
  await page.getByText("Operational health", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("Model readiness", { exact: true }).first().waitFor({ timeout: 10_000 });
  await page.getByText("Audit Ledger", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("Reviewer eval health", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("pass 100%").waitFor({ timeout: 10_000 });
  await page.getByText("Improvement Intelligence", { exact: true }).waitFor({ timeout: 10_000 });
  await page
    .getByText("Self-Improvement dashboard workflow simplification signal")
    .first()
    .waitFor({
      timeout: 10_000,
    });
  await page.getByText("Memory/Skill Curator Queue", { exact: true }).waitFor({
    timeout: 10_000,
  });
  await page.getByText("Pending memory/skill proposal: dashboard smoke curation").waitFor({
    timeout: 10_000,
  });
  await page
    .getByText("Checked Self-Improvement model readiness: degraded.", { exact: true })
    .waitFor({ timeout: 10_000 });
  await page.getByText("primaryRemediationHint").waitFor({ timeout: 10_000 });
  const recommendationsScreenshot = join(artifactDir, "01-recommendations.png");
  screenshots.push(recommendationsScreenshot);
  await page.screenshot({ path: recommendationsScreenshot, fullPage: false });
  snapshots.push(await snapshotSelfImprovement(page, "recommendations-loaded"));

  await page.getByRole("button", { name: "Run analysis", exact: true }).click({
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            selfImprovementAnalysisLoading?: boolean;
            selfImprovementLastAnalysis?: { groupsAnalyzed?: number; mode?: string } | null;
            selfImprovementProposals?: unknown[];
          })
        | null;
      return (
        app?.selfImprovementAnalysisLoading === false &&
        app.selfImprovementLastAnalysis?.mode === "deterministic" &&
        (app.selfImprovementLastAnalysis.groupsAnalyzed ?? 0) > 0 &&
        (app.selfImprovementProposals?.length ?? 0) > 0
      );
    },
    null,
    { timeout: 45_000 },
  );
  await page.getByText("Last analysis", { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText("schema not validated").waitFor({ timeout: 10_000 });
  await page.getByText("Proposal Queue", { exact: true }).waitFor({ timeout: 10_000 });
  const analysisScreenshot = join(artifactDir, "02-analysis.png");
  screenshots.push(analysisScreenshot);
  await page.screenshot({ path: analysisScreenshot, fullPage: false });
  snapshots.push(await snapshotSelfImprovement(page, "analysis-complete"));

  await page.getByRole("button", { name: "Check models", exact: true }).click({
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            selfImprovementError?: string | null;
            selfImprovementLastModelPreflight?: {
              attempts?: unknown[];
              preflightStatus?: string;
              ready?: boolean;
              readiness?: string;
              reviewPolicy?: string;
            } | null;
            selfImprovementModelPreflightLoading?: boolean;
          })
        | null;
      return (
        app?.selfImprovementModelPreflightLoading === false &&
        (Boolean(app.selfImprovementLastModelPreflight) || Boolean(app.selfImprovementError))
      );
    },
    null,
    { timeout: 30_000 },
  );
  const modelPreflightState = await readModelPreflightUiState(page);
  if (
    !modelPreflightState.lastModelPreflight ||
    modelPreflightState.lastModelPreflight.reviewPolicy !== "local_first" ||
    !["ready", "degraded", "blocked"].includes(modelPreflightState.lastModelPreflight.readiness) ||
    !["passed", "missing_config", "unavailable"].includes(
      modelPreflightState.lastModelPreflight.preflightStatus,
    ) ||
    modelPreflightState.lastModelPreflight.attempts <= 0
  ) {
    throw new Error(
      `Model preflight did not reach the expected local-first state: ${JSON.stringify(
        modelPreflightState,
      )}`,
    );
  }
  await page.getByText("Model readiness", { exact: true }).first().waitFor({ timeout: 10_000 });
  await page
    .getByText(/passed|missing_config|unavailable/)
    .first()
    .waitFor({ timeout: 10_000 });
  const modelPreflightScreenshot = join(artifactDir, "03-model-preflight.png");
  screenshots.push(modelPreflightScreenshot);
  await page.screenshot({ path: modelPreflightScreenshot, fullPage: false });
  snapshots.push(await snapshotSelfImprovement(page, "model-preflight-complete"));

  await page.getByRole("button", { name: "Production check", exact: true }).click({
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            selfImprovementLastProductionCheck?: { status?: string; evidence?: unknown[] } | null;
            selfImprovementProductionCheckLoading?: boolean;
          })
        | null;
      return (
        app?.selfImprovementProductionCheckLoading === false &&
        Boolean(app.selfImprovementLastProductionCheck) &&
        (app.selfImprovementLastProductionCheck?.evidence?.length ?? 0) > 0
      );
    },
    null,
    { timeout: 30_000 },
  );
  await page.getByText("Production readiness", { exact: true }).waitFor({ timeout: 10_000 });

  await page.getByRole("button", { name: "Maintenance dry run", exact: true }).click({
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            selfImprovementLastMaintenance?: { dryRun?: boolean; stores?: unknown[] } | null;
            selfImprovementMaintenanceLoading?: boolean;
          })
        | null;
      return (
        app?.selfImprovementMaintenanceLoading === false &&
        app.selfImprovementLastMaintenance?.dryRun === true &&
        (app.selfImprovementLastMaintenance.stores?.length ?? 0) > 0
      );
    },
    null,
    { timeout: 30_000 },
  );
  await page.getByText("Retention maintenance", { exact: true }).waitFor({ timeout: 10_000 });
  const productionScreenshot = join(artifactDir, "04-production-readiness.png");
  screenshots.push(productionScreenshot);
  await page.screenshot({ path: productionScreenshot, fullPage: false });
  snapshots.push(await snapshotSelfImprovement(page, "production-readiness-complete"));
  return { screenshots, snapshots };
}

async function main() {
  const artifactDir =
    process.env.OPENCLAW_CONTROL_UI_SELF_IMPROVEMENT_ARTIFACT_DIR?.trim() ||
    join(".artifacts", "control-ui-self-improvement", timestampSlug());
  mkdirSync(artifactDir, { recursive: true });

  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }

  let browser: Browser | null = null;
  let gateway: GatewayInstance | null = null;
  const consoleErrors: string[] = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  try {
    gateway = await startIsolatedGateway(artifactDir);
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
    await context.addInitScript(
      (metadata) => {
        localStorage.setItem("openclaw.controlUi.clientMetadata", JSON.stringify(metadata));
      },
      {
        deviceFamily: "control-ui-smoke",
        displayName: "OpenClaw Self-Improvement smoke desktop profile",
        platform: "desktop",
      },
    );
    const page = await context.newPage();
    await page.addInitScript("globalThis.__name = (fn) => fn;");
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(redactSmokeSecrets(message.text()));
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        responseErrors.push(`${response.status()} ${redactSmokeSecrets(response.url())}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(redactSmokeSecrets(error.message)));

    await page.goto(appendControlUiTokenFragment(gateway.url, gateway.token), {
      waitUntil: "domcontentloaded",
    });
    const { screenshots, snapshots } = await runSelfImprovementFlow(page, artifactDir);
    const authUrlClean = await page.evaluate(
      () => !/(?:[#?&])(?:token|password)=/i.test(window.location.href),
    );
    if (!authUrlClean) {
      throw new Error("Dashboard left auth material in the browser URL after bootstrap.");
    }
    if (consoleErrors.length > 0 || responseErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `Self-Improvement smoke saw browser errors: ${JSON.stringify({
          consoleErrors,
          pageErrors,
          responseErrors,
        })}`,
      );
    }

    const summary: SelfImprovementSmokeSummary = {
      artifactDir,
      authUrlClean,
      consoleErrors,
      pageErrors,
      responseErrors,
      screenshots,
      seededRecommendationId: "sir_self_improvement_dashboard_smoke",
      snapshots,
      stateDir: gateway.stateDir,
      url: gateway.url,
      ok: true,
    };
    writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`control-ui-self-improvement-smoke: ok ${JSON.stringify(summary, null, 2)}`);
  } catch (error) {
    const logs = gateway ? `\nGateway logs:\n${formatLogs(gateway.stdout, gateway.stderr)}` : "";
    throw new Error(
      `${redactSmokeSecrets(error instanceof Error ? error.stack || error.message : String(error))}${logs}`,
      { cause: error },
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await gateway?.stop().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      "control-ui-self-improvement-smoke: failed",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
