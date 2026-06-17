// Local UX Matrix dashboard and runner for serial, proof-producing surface checks.
import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

type CellStatus =
  | "pass"
  | "fail"
  | "blocked"
  | "environment-issue"
  | "automation-issue"
  | "proof-gap"
  | "not-applicable"
  | "fixed-in-pr";

type AutomationReadiness = "now-local" | "now-ci" | "later-heavy" | "manual-only";

type SurfaceId =
  | "android"
  | "ios-simulator"
  | "ipad-simulator"
  | "macos-app"
  | "web-ui"
  | "cli"
  | "tui"
  | "watchos"
  | "matrix-live";

type StageId =
  | "install-or-build"
  | "first-run"
  | "gateway-discovery"
  | "gateway-connected-healthy"
  | "setup-code-entry"
  | "device-paired"
  | "node-capability-wait"
  | "node-approved-ready"
  | "permission-setup"
  | "active-chat-session"
  | "talk-active-stop"
  | "pending-approval-action"
  | "history-completed-session"
  | "disconnect-recovery"
  | "error-state";

type ProofArtifacts = {
  gif?: string;
  logs?: string[];
  machineValidation?: string;
  recording?: string;
  recordingDurationMs?: number;
  recordingType?: "webm" | "gif";
  screenshot?: string;
  uiTree?: string;
};

type MatrixCell = {
  automation: AutomationReadiness;
  proof: ProofArtifacts;
  reason: string;
  stage: StageId;
  status: CellStatus;
  surface: SurfaceId;
};

type StageResult = MatrixCell & {
  durationMs: number;
  endedAt: string;
  startedAt: string;
};

type CliCommandResult = {
  args: string[];
  command: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type RunState = "idle" | "running" | "pass" | "fail" | "blocked";

type RunSummary = {
  artifactRoot: string;
  branch: string;
  dirty: boolean;
  endedAt?: string;
  gitSha: string;
  runId: string;
  startedAt: string;
  status: RunState;
};

type RunHistoryEntry = RunSummary & {
  counts?: Partial<Record<CellStatus, number>>;
};

type RunnerOptions = {
  artifactBase: string;
  recordingMs: number;
  repoRoot: string;
};

type ServerOptions = RunnerOptions & {
  host: string;
  once: boolean;
  port: number;
  runOnStart: boolean;
};

type QaEvidenceStatus = "pass" | "fail" | "blocked" | "skipped";

type QaEvidenceArtifact = {
  kind: string;
  path: string;
  source: string;
};

type QaEvidenceEntry = {
  test: {
    kind: string;
    id: string;
    title: string;
    source?: {
      path: string;
    };
  };
  coverage: Array<{
    id: string;
    role: "primary" | "secondary";
  }>;
  execution?: {
    runner: string;
    environment: {
      ref: string | null;
      os: string;
      nodeVersion: string;
    };
    provider: {
      id: string;
      live: boolean;
      model: {
        name: string | null;
        ref: string | null;
      };
      fixture?: string;
    };
    packageSource: {
      kind: string;
      sha?: string;
    };
    artifacts: QaEvidenceArtifact[];
  };
  result: {
    status: QaEvidenceStatus;
    failure?: {
      class?: string;
      reason: string;
    };
    timing?: {
      wallMs?: number;
    };
  };
};

type QaEvidenceSummary = {
  kind: "openclaw.qa.evidence-summary";
  schemaVersion: 2;
  generatedAt: string;
  evidenceMode: "full";
  entries: QaEvidenceEntry[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultArtifactBase = path.join(repoRoot, ".artifacts", "ux-matrix");

const stages: Array<{ id: StageId; label: string }> = [
  { id: "install-or-build", label: "Install / build" },
  { id: "first-run", label: "First run" },
  { id: "gateway-discovery", label: "Gateway discovery" },
  { id: "gateway-connected-healthy", label: "Gateway healthy" },
  { id: "setup-code-entry", label: "Setup-code entry" },
  { id: "device-paired", label: "Device paired" },
  { id: "node-capability-wait", label: "Node approval wait" },
  { id: "node-approved-ready", label: "Node approved" },
  { id: "permission-setup", label: "Permission setup" },
  { id: "active-chat-session", label: "Active chat" },
  { id: "talk-active-stop", label: "Talk active / stop" },
  { id: "pending-approval-action", label: "Pending approval action" },
  { id: "history-completed-session", label: "History / completed" },
  { id: "disconnect-recovery", label: "Disconnect recovery" },
  { id: "error-state", label: "Error state" },
];

const surfaces: Array<{ id: SurfaceId; label: string; readiness: AutomationReadiness }> = [
  { id: "web-ui", label: "Web UI", readiness: "now-local" },
  { id: "android", label: "Android", readiness: "later-heavy" },
  { id: "ios-simulator", label: "iPhone Simulator", readiness: "later-heavy" },
  { id: "ipad-simulator", label: "iPad Simulator", readiness: "later-heavy" },
  { id: "macos-app", label: "macOS app", readiness: "later-heavy" },
  { id: "cli", label: "CLI", readiness: "now-local" },
  { id: "tui", label: "TUI", readiness: "now-local" },
  { id: "watchos", label: "watchOS", readiness: "later-heavy" },
  { id: "matrix-live", label: "Matrix live", readiness: "manual-only" },
];

let activeRun: Promise<RunSummary> | null = null;
let activeRunSnapshot: RunSummary | null = null;

function parseArgs(args: string[]): ServerOptions {
  const options: ServerOptions = {
    artifactBase: defaultArtifactBase,
    host: "127.0.0.1",
    port: 5199,
    recordingMs: 8_000,
    once: false,
    repoRoot,
    runOnStart: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifact-base") {
      options.artifactBase = path.resolve(args[++index] ?? options.artifactBase);
    } else if (arg.startsWith("--artifact-base=")) {
      options.artifactBase = path.resolve(arg.slice("--artifact-base=".length));
    } else if (arg === "--host") {
      options.host = args[++index] ?? options.host;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length) || options.host;
    } else if (arg === "--port") {
      options.port = parsePort(args[++index], options.port);
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), options.port);
    } else if (arg === "--recording-ms") {
      options.recordingMs = parsePositiveInteger(args[++index], options.recordingMs);
    } else if (arg.startsWith("--recording-ms=")) {
      options.recordingMs = parsePositiveInteger(
        arg.slice("--recording-ms=".length),
        options.recordingMs,
      );
    } else if (arg === "--run-on-start") {
      options.runOnStart = true;
    } else if (arg === "--once" || arg === "--headless") {
      options.once = true;
      options.runOnStart = true;
    }
  }
  return options;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function execText(command: string, args: string[], cwd = repoRoot): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`${stdout}${stderr}`.trim());
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function execCaptured(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CliCommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd ?? repoRoot,
        env: options.env,
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeoutMs ?? 15_000,
      },
      (error, stdout, stderr) => {
        const maybeError = error as
          | (Error & { code?: number | string; killed?: boolean; signal?: string })
          | null;
        resolve({
          args,
          command,
          durationMs: Date.now() - started,
          exitCode: typeof maybeError?.code === "number" ? maybeError.code : maybeError ? 1 : 0,
          signal: maybeError?.signal ?? null,
          stderr,
          stdout,
          timedOut: Boolean(maybeError?.killed),
        });
      },
    );
  });
}

async function gitInfo() {
  const [sha, branch, status] = await Promise.all([
    execText("git", ["rev-parse", "HEAD"]),
    execText("git", ["branch", "--show-current"]),
    execText("git", ["status", "--short"]),
  ]);
  return {
    branch: branch || "detached",
    dirty: Boolean(status.trim()),
    sha: sha.trim(),
  };
}

function utcStamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function relativeToRun(runRoot: string, filePath: string): string {
  return path.relative(runRoot, filePath).split(path.sep).join("/");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

function createInitialCells(): MatrixCell[] {
  return surfaces.flatMap((surface) =>
    stages.map((stage) => ({
      automation: surface.readiness,
      proof: {},
      reason:
        surface.id === "web-ui"
          ? "Queued for the MVP mocked web UI lane."
          : surface.id === "cli"
            ? "Queued for the MVP serial CLI status lane."
            : "Represented in MVP shell; not executed in this local low-memory slice.",
      stage: stage.id,
      status: "proof-gap" as CellStatus,
      surface: surface.id,
    })),
  );
}

function replaceCell(cells: MatrixCell[], result: MatrixCell): MatrixCell[] {
  return cells.map((cell) =>
    cell.surface === result.surface && cell.stage === result.stage ? result : cell,
  );
}

function redactText(value: string, runRoot: string): string {
  const username = process.env.USER ?? "";
  const redactedHome = value
    .replaceAll(runRoot, "[run-root]")
    .replaceAll(repoRoot, "[repo-root]")
    .replace(
      new RegExp(process.env.HOME?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "$^", "g"),
      "[home]",
    )
    .replace(/\/tmp\/openclaw\/[^\s",]+/g, "[openclaw-log]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/(--token\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("apiKey"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/(OPENCLAW_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)[A-Z0-9_]*=)[^\s]+/g, "$1[redacted]");
  return username ? redactedHome.replaceAll(username, "[user]") : redactedHome;
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function countStatuses(cells: MatrixCell[]): Record<CellStatus, number> {
  const counts = Object.fromEntries(
    [
      "pass",
      "fail",
      "blocked",
      "environment-issue",
      "automation-issue",
      "proof-gap",
      "not-applicable",
      "fixed-in-pr",
    ].map((status) => [status, 0]),
  ) as Record<CellStatus, number>;
  for (const cell of cells) {
    counts[cell.status] += 1;
  }
  return counts;
}

function countIssueStatuses(counts: Record<CellStatus, number>): number {
  return counts.fail + counts.blocked + counts["environment-issue"] + counts["automation-issue"];
}

function isCellStatus(value: unknown): value is CellStatus {
  return (
    value === "pass" ||
    value === "fail" ||
    value === "blocked" ||
    value === "environment-issue" ||
    value === "automation-issue" ||
    value === "proof-gap" ||
    value === "not-applicable" ||
    value === "fixed-in-pr"
  );
}

function isExecutedUxMatrixCell(cell: MatrixCell): boolean {
  return cell.status !== "proof-gap";
}

function cellStatusToQaStatus(status: CellStatus): QaEvidenceStatus {
  if (status === "pass" || status === "fixed-in-pr") {
    return "pass";
  }
  if (status === "fail" || status === "automation-issue") {
    return "fail";
  }
  if (status === "not-applicable") {
    return "skipped";
  }
  return "blocked";
}

function qaStatusToCellStatus(entry: QaEvidenceEntry): CellStatus {
  const failureClass = entry.result.failure?.class;
  if (isCellStatus(failureClass)) {
    return failureClass;
  }
  if (entry.result.status === "pass") {
    return "pass";
  }
  if (entry.result.status === "fail") {
    return "fail";
  }
  if (entry.result.status === "skipped") {
    return "not-applicable";
  }
  return "blocked";
}

function uxMatrixCoverageForCell(cell: MatrixCell): QaEvidenceEntry["coverage"] {
  if (cell.surface === "web-ui") {
    return [{ id: "ui.control", role: "primary" }];
  }
  if (cell.surface === "cli" && cell.stage === "install-or-build") {
    return [{ id: "cli-entrypoint", role: "primary" }];
  }
  if (cell.surface === "cli" && cell.stage === "error-state") {
    return [{ id: "status-snapshots", role: "primary" }];
  }
  return [];
}

function proofToQaArtifacts(proof: ProofArtifacts, source: string): QaEvidenceArtifact[] {
  const artifacts: QaEvidenceArtifact[] = [];
  if (proof.screenshot) {
    artifacts.push({ kind: "screenshot", path: proof.screenshot, source });
  }
  if (proof.gif) {
    artifacts.push({ kind: "motion-preview-gif", path: proof.gif, source });
  }
  if (proof.recording) {
    artifacts.push({
      kind: proof.recording.endsWith(".gif") ? "recording-gif" : "video",
      path: proof.recording,
      source,
    });
  }
  for (const logPath of proof.logs ?? []) {
    artifacts.push({ kind: "log", path: logPath, source });
  }
  if (proof.machineValidation) {
    artifacts.push({ kind: "machine-validation", path: proof.machineValidation, source });
  }
  if (proof.uiTree) {
    artifacts.push({ kind: "ui-tree", path: proof.uiTree, source });
  }
  return artifacts;
}

function proofFromQaArtifacts(
  artifacts: readonly QaEvidenceArtifact[] | undefined,
): ProofArtifacts {
  const proof: ProofArtifacts = {};
  const logs: string[] = [];
  for (const artifact of artifacts ?? []) {
    if (artifact.kind === "screenshot") {
      proof.screenshot = artifact.path;
    } else if (artifact.kind === "motion-preview-gif" || artifact.kind === "recording-gif") {
      proof.gif = artifact.path;
    } else if (artifact.kind === "video") {
      proof.recording = artifact.path;
      proof.recordingType = "webm";
    } else if (artifact.kind === "log") {
      logs.push(artifact.path);
    } else if (artifact.kind === "machine-validation") {
      proof.machineValidation = artifact.path;
    } else if (artifact.kind === "ui-tree") {
      proof.uiTree = artifact.path;
    }
  }
  if (logs.length > 0) {
    proof.logs = logs;
  }
  return proof;
}

function buildUxMatrixQaEvidence(params: {
  cells: MatrixCell[];
  generatedAt: string;
  summary: RunSummary;
}): QaEvidenceSummary {
  const entries = params.cells.filter(isExecutedUxMatrixCell).map((cell): QaEvidenceEntry => {
    const source = `ux-matrix:${cell.surface}:${cell.stage}`;
    const qaStatus = cellStatusToQaStatus(cell.status);
    return {
      test: {
        kind: "ux-matrix-cell",
        id: `ux-matrix.${cell.surface}.${cell.stage}`,
        title: `UX Matrix: ${cell.surface} / ${cell.stage}`,
        source: {
          path: "scripts/ux-matrix/dashboard.ts",
        },
      },
      coverage: uxMatrixCoverageForCell(cell),
      execution: {
        runner: "ux-matrix-dashboard",
        environment: {
          ref: process.env.GITHUB_SHA?.trim() || params.summary.gitSha || null,
          os: process.platform,
          nodeVersion: process.version,
        },
        provider: {
          id: "ux-matrix",
          live: false,
          model: {
            name: null,
            ref: null,
          },
          fixture: "mocked-control-ui-and-isolated-cli",
        },
        packageSource: {
          kind: "source-checkout",
          sha: params.summary.gitSha,
        },
        artifacts: proofToQaArtifacts(cell.proof, source),
      },
      result: {
        status: qaStatus,
        failure:
          qaStatus === "pass"
            ? undefined
            : {
                class: cell.status,
                reason: cell.reason,
              },
        timing:
          "durationMs" in cell &&
          typeof (cell as Partial<StageResult>).durationMs === "number" &&
          Number.isFinite((cell as Partial<StageResult>).durationMs)
            ? { wallMs: (cell as Partial<StageResult>).durationMs }
            : undefined,
      },
    };
  });
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: params.generatedAt,
    evidenceMode: "full",
    entries,
  };
}

function qaEvidenceEntryKey(entry: QaEvidenceEntry): { stage: StageId; surface: SurfaceId } | null {
  const match = /^ux-matrix\.([a-z-]+)\.([a-z-]+)$/.exec(entry.test.id);
  if (!match) {
    return null;
  }
  const [, surface, stage] = match;
  if (
    surfaces.some((candidate) => candidate.id === surface) &&
    stages.some((candidate) => candidate.id === stage)
  ) {
    return { surface: surface as SurfaceId, stage: stage as StageId };
  }
  return null;
}

function matrixCellFromQaEvidenceEntry(entry: QaEvidenceEntry): StageResult | null {
  const key = qaEvidenceEntryKey(entry);
  if (!key) {
    return null;
  }
  const status = qaStatusToCellStatus(entry);
  const durationMs = entry.result.timing?.wallMs ?? 0;
  return {
    automation: surfaces.find((surface) => surface.id === key.surface)?.readiness ?? "manual-only",
    durationMs,
    endedAt: "",
    proof: proofFromQaArtifacts(entry.execution?.artifacts),
    reason: entry.result.failure?.reason ?? entry.test.title,
    stage: key.stage,
    startedAt: "",
    status,
    surface: key.surface,
  };
}

function matrixFromQaEvidence(
  qaEvidence: Record<string, unknown> | null,
  fallbackRun?: RunSummary,
) {
  if (!qaEvidence || !Array.isArray(qaEvidence.entries)) {
    return null;
  }
  let cells = createInitialCells();
  for (const entry of qaEvidence.entries as QaEvidenceEntry[]) {
    const cell = matrixCellFromQaEvidenceEntry(entry);
    if (cell) {
      cells = replaceCell(cells, cell);
    }
  }
  return {
    schemaVersion: 1,
    cells,
    counts: countStatuses(cells),
    generatedAt: typeof qaEvidence.generatedAt === "string" ? qaEvidence.generatedAt : "",
    run: fallbackRun,
    stages,
    surfaces,
  };
}

function applyQaEvidenceToMatrix(
  matrix: Record<string, unknown> | null,
  qaEvidence: Record<string, unknown> | null,
) {
  if (
    !matrix ||
    !Array.isArray(matrix.cells) ||
    !qaEvidence ||
    !Array.isArray(qaEvidence.entries)
  ) {
    return matrix;
  }
  let cells = matrix.cells as MatrixCell[];
  for (const entry of qaEvidence.entries as QaEvidenceEntry[]) {
    const qaCell = matrixCellFromQaEvidenceEntry(entry);
    if (!qaCell) {
      continue;
    }
    const existing = cells.find(
      (cell) => cell.surface === qaCell.surface && cell.stage === qaCell.stage,
    );
    cells = replaceCell(cells, {
      ...(existing ?? qaCell),
      durationMs: qaCell.durationMs,
      proof: qaCell.proof,
      reason: qaCell.reason,
      status: qaCell.status,
    } as StageResult);
  }
  return {
    ...matrix,
    cells,
    counts: countStatuses(cells),
  };
}

async function preflight(runRoot: string) {
  const [vmStat, ps, adbDevices] = await Promise.all([
    execText("vm_stat", []),
    execText("ps", ["-axo", "pid,comm,rss"]),
    execText("adb", ["devices", "-l"]),
  ]);
  const heavyPatterns = [/qemu-system/i, /\bemulator\b/i, /Simulator/i, /GradleDaemon/i];
  const heavyProcesses = ps
    .split(/\r?\n/)
    .filter((line) => heavyPatterns.some((pattern) => pattern.test(line)))
    .slice(0, 20);
  const warnings = [
    ...heavyProcesses.map((line) => `heavy process already running: ${line.trim()}`),
    ...(adbDevices.includes("\tdevice")
      ? ["adb has attached devices; MVP will not touch them."]
      : []),
  ];
  await writeText(
    path.join(runRoot, "preflight", "memory.txt"),
    [`# vm_stat`, vmStat, "", "# heavy processes", heavyProcesses.join("\n") || "none"].join("\n"),
  );
  await writeText(
    path.join(runRoot, "preflight", "adb-devices.txt"),
    adbDevices || "adb unavailable",
  );
  return {
    adbDevices: adbDevices || "adb unavailable",
    heavyProcesses,
    memorySnapshot: "preflight/memory.txt",
    warnings,
  };
}

async function waitForGatewayMethods(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  methods: string[],
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests();
    const observed = new Set(requests.map((request) => request.method));
    if (methods.every((method) => observed.has(method))) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  const requests = await gateway.getRequests();
  throw new Error(
    `Timed out waiting for Gateway methods ${methods.join(", ")}; observed ${requests
      .map((request) => request.method)
      .join(", ")}`,
  );
}

async function runWebUiLane(runRoot: string, recordingMs: number): Promise<StageResult[]> {
  const firstRunDir = path.join(runRoot, "surfaces", "web-ui", "stages", "first-run");
  const gatewayDir = path.join(
    runRoot,
    "surfaces",
    "web-ui",
    "stages",
    "gateway-connected-healthy",
  );
  const sharedVideoDir = path.join(runRoot, "surfaces", "web-ui", "videos");
  await Promise.all([
    mkdir(firstRunDir, { recursive: true }),
    mkdir(gatewayDir, { recursive: true }),
    mkdir(sharedVideoDir, { recursive: true }),
  ]);
  const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const startedAt = new Date();
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    const endedAt = new Date();
    const reason = `Playwright Chromium is not runnable at ${chromiumExecutablePath}.`;
    const result = createFailedWebStage(
      "first-run",
      firstRunDir,
      runRoot,
      startedAt,
      endedAt,
      reason,
    );
    await writeStageArtifacts(firstRunDir, result, { chromiumExecutablePath, error: reason });
    return [result];
  }

  let server: Awaited<ReturnType<typeof startControlUiE2eServer>> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const requestsLog: string[] = [];
  try {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const captureStartedAt = Date.now();
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: sharedVideoDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "UX matrix web lane ready.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("UX matrix web lane ready.").waitFor({ timeout: 10_000 });
    const firstRunScreenshot = path.join(firstRunDir, "screenshot.png");
    await page.screenshot({ fullPage: true, path: firstRunScreenshot });
    const initialRequests = await gateway.getRequests();
    requestsLog.push(...initialRequests.map((request) => JSON.stringify(request)));

    const gatewayRequests = await waitForGatewayMethods(gateway, ["connect", "chat.startup"]);
    const gatewayScreenshot = path.join(gatewayDir, "screenshot.png");
    await page.screenshot({ fullPage: true, path: gatewayScreenshot });
    requestsLog.push(...gatewayRequests.map((request) => JSON.stringify(request)));
    await holdMeaningfulRecording(page, captureStartedAt, recordingMs);

    const video = page.video();
    await context.close();
    const videoPath = video ? await video.path() : "";
    const firstRunRecording = path.join(firstRunDir, "recording.webm");
    const gatewayRecording = path.join(gatewayDir, "recording.webm");
    const firstRunGif = path.join(firstRunDir, "recording.gif");
    const gatewayGif = path.join(gatewayDir, "recording.gif");
    let gifConversion: { ok: boolean; reason?: string } = { ok: false, reason: "no recording" };
    if (videoPath) {
      const bytes = await readFile(videoPath);
      await Promise.all([writeFile(firstRunRecording, bytes), writeFile(gatewayRecording, bytes)]);
      const [firstGifResult, gatewayGifResult] = await Promise.all([
        convertRecordingToGif(firstRunRecording, firstRunGif),
        convertRecordingToGif(gatewayRecording, gatewayGif),
      ]);
      gifConversion =
        firstGifResult.ok && gatewayGifResult.ok
          ? { ok: true }
          : { ok: false, reason: firstGifResult.reason ?? gatewayGifResult.reason };
    }

    const endedAt = new Date();
    const actualRecordingDurationMs = Date.now() - captureStartedAt;
    const firstRunResult = createPassedStage({
      durationMs: endedAt.getTime() - startedAt.getTime(),
      endedAt,
      proof: {
        logs: [relativeToRun(runRoot, path.join(firstRunDir, "logs.txt"))],
        machineValidation: relativeToRun(
          runRoot,
          path.join(firstRunDir, "machine-validation.json"),
        ),
        recording: videoPath ? relativeToRun(runRoot, firstRunRecording) : undefined,
        gif: gifConversion.ok ? relativeToRun(runRoot, firstRunGif) : undefined,
        recordingDurationMs: actualRecordingDurationMs,
        recordingType: gifConversion.ok ? "gif" : "webm",
        screenshot: relativeToRun(runRoot, firstRunScreenshot),
      },
      reason: "Mocked Control UI loaded and rendered the expected first-run chat state.",
      stage: "first-run",
      startedAt,
    });
    const gatewayResult = createPassedStage({
      durationMs: endedAt.getTime() - startedAt.getTime(),
      endedAt,
      proof: {
        logs: [relativeToRun(runRoot, path.join(gatewayDir, "logs.txt"))],
        machineValidation: relativeToRun(runRoot, path.join(gatewayDir, "machine-validation.json")),
        recording: videoPath ? relativeToRun(runRoot, gatewayRecording) : undefined,
        gif: gifConversion.ok ? relativeToRun(runRoot, gatewayGif) : undefined,
        recordingDurationMs: actualRecordingDurationMs,
        recordingType: gifConversion.ok ? "gif" : "webm",
        screenshot: relativeToRun(runRoot, gatewayScreenshot),
      },
      reason: "Mock Gateway handshake completed and chat startup requests were observed.",
      stage: "gateway-connected-healthy",
      startedAt,
    });
    await Promise.all([
      writeStageArtifacts(firstRunDir, firstRunResult, {
        chromiumExecutablePath,
        observedMethods: Array.from(new Set(initialRequests.map((request) => request.method))),
        gifConversion,
        requestedRecordingMs: recordingMs,
        recordingDurationMs: actualRecordingDurationMs,
        serverUrl: server.baseUrl,
        textFound: "UX matrix web lane ready.",
      }),
      writeStageArtifacts(gatewayDir, gatewayResult, {
        chromiumExecutablePath,
        observedMethods: Array.from(new Set(gatewayRequests.map((request) => request.method))),
        gifConversion,
        requestedRecordingMs: recordingMs,
        recordingDurationMs: actualRecordingDurationMs,
        requiredMethods: ["connect", "chat.startup"],
        serverUrl: server.baseUrl,
      }),
      writeText(path.join(firstRunDir, "logs.txt"), requestsLog.join("\n") + "\n"),
      writeText(path.join(gatewayDir, "logs.txt"), requestsLog.join("\n") + "\n"),
    ]);
    return [firstRunResult, gatewayResult];
  } catch (error) {
    const endedAt = new Date();
    const reason = error instanceof Error ? error.message : String(error);
    const result = createFailedWebStage(
      "first-run",
      firstRunDir,
      runRoot,
      startedAt,
      endedAt,
      reason,
    );
    await writeStageArtifacts(firstRunDir, result, {
      chromiumExecutablePath,
      error: reason,
      requests: requestsLog,
    });
    await writeText(path.join(firstRunDir, "logs.txt"), `${reason}\n${requestsLog.join("\n")}\n`);
    return [result];
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

async function holdMeaningfulRecording(
  page: Page,
  captureStartedAt: number,
  recordingMs: number,
): Promise<void> {
  const remaining = Math.max(0, recordingMs - (Date.now() - captureStartedAt));
  if (remaining <= 0) {
    return;
  }
  await page.mouse.move(96, 96);
  await page.waitForTimeout(Math.min(1_000, remaining));
  if (remaining > 1_000) {
    await page.locator(".agent-chat__composer-combobox textarea").fill("ux matrix proof capture");
    await page.waitForTimeout(Math.min(1_500, remaining - 1_000));
  }
  const finalRemaining = Math.max(0, recordingMs - (Date.now() - captureStartedAt));
  if (finalRemaining > 0) {
    await page.mouse.move(1_080, 820);
    await page.waitForTimeout(finalRemaining);
  }
}

async function convertRecordingToGif(
  inputPath: string,
  outputPath: string,
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", inputPath, "-vf", "fps=8,scale=960:-1:flags=lanczos", "-loop", "0", outputPath],
      { timeout: 30_000 },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            reason: stderr.trim() || error.message || "ffmpeg gif conversion failed",
          });
          return;
        }
        resolve({ ok: true });
      },
    );
  });
}

function createPassedStage(params: {
  durationMs: number;
  endedAt: Date;
  proof: ProofArtifacts;
  reason: string;
  stage: StageId;
  startedAt: Date;
}): StageResult {
  return {
    automation: "now-local",
    durationMs: params.durationMs,
    endedAt: params.endedAt.toISOString(),
    proof: params.proof,
    reason: params.reason,
    stage: params.stage,
    startedAt: params.startedAt.toISOString(),
    status: "pass",
    surface: "web-ui",
  };
}

function createFailedWebStage(
  stage: StageId,
  stageDir: string,
  runRoot: string,
  startedAt: Date,
  endedAt: Date,
  reason: string,
): StageResult {
  const status: CellStatus = /Chromium|Playwright|not runnable/i.test(reason)
    ? "environment-issue"
    : "automation-issue";
  return {
    automation: "now-local",
    durationMs: endedAt.getTime() - startedAt.getTime(),
    endedAt: endedAt.toISOString(),
    proof: {
      logs: [relativeToRun(runRoot, path.join(stageDir, "logs.txt"))],
      machineValidation: relativeToRun(runRoot, path.join(stageDir, "machine-validation.json")),
    },
    reason,
    stage,
    startedAt: startedAt.toISOString(),
    status,
    surface: "web-ui",
  };
}

function createCliStage(params: {
  durationMs: number;
  endedAt: Date;
  proof: ProofArtifacts;
  reason: string;
  stage: StageId;
  startedAt: Date;
  status: CellStatus;
}): StageResult {
  return {
    automation: "now-local",
    durationMs: params.durationMs,
    endedAt: params.endedAt.toISOString(),
    proof: params.proof,
    reason: params.reason,
    stage: params.stage,
    startedAt: params.startedAt.toISOString(),
    status: params.status,
    surface: "cli",
  };
}

function isolatedCliEnv(runRoot: string): NodeJS.ProcessEnv {
  const cliRoot = path.join(runRoot, "private", "cli");
  const cliHome = path.join(cliRoot, "home");
  return {
    ...process.env,
    HOME: cliHome,
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: path.join(cliHome, ".openclaw", "openclaw.json"),
    OPENCLAW_HOME: cliHome,
    OPENCLAW_STATE_DIR: path.join(cliRoot, "state"),
  };
}

async function runCliStage(
  runRoot: string,
  params: {
    args: string[];
    classify: (
      result: CliCommandResult,
      parsed: Record<string, unknown> | null,
    ) => {
      classification: string;
      reason: string;
      status: CellStatus;
    };
    stage: StageId;
    timeoutMs?: number;
  },
): Promise<StageResult> {
  const stageDir = path.join(runRoot, "surfaces", "cli", "stages", params.stage);
  await mkdir(stageDir, { recursive: true });
  const startedAt = new Date();
  const result = await execCaptured(process.execPath, params.args, {
    cwd: repoRoot,
    env: isolatedCliEnv(runRoot),
    timeoutMs: params.timeoutMs ?? 15_000,
  });
  const endedAt = new Date();
  const stdout = redactText(result.stdout, runRoot);
  const stderr = redactText(result.stderr, runRoot);
  const parsed = tryParseJsonObject(stdout.trim());
  const classification = params.classify({ ...result, stderr, stdout }, parsed);
  const logsPath = path.join(stageDir, "logs.txt");
  const validationPath = path.join(stageDir, "machine-validation.json");
  const commandLine = `node ${params.args.join(" ")}`;
  const stageResult = createCliStage({
    durationMs: result.durationMs,
    endedAt,
    proof: {
      logs: [relativeToRun(runRoot, logsPath)],
      machineValidation: relativeToRun(runRoot, validationPath),
    },
    reason: classification.reason,
    stage: params.stage,
    startedAt,
    status: classification.status,
  });
  await Promise.all([
    writeText(
      logsPath,
      [
        `command: ${commandLine}`,
        `exitCode: ${result.exitCode}`,
        `durationMs: ${result.durationMs}`,
        `timedOut: ${result.timedOut}`,
        "",
        "# stdout",
        stdout.trim() || "(empty)",
        "",
        "# stderr",
        stderr.trim() || "(empty)",
        "",
      ].join("\n"),
    ),
    writeStageArtifacts(stageDir, stageResult, {
      args: params.args,
      classification: classification.classification,
      command: process.execPath,
      commandLine,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      parsedStatus: parsed,
      signal: result.signal,
      stderrLineCount: stderr.trim() ? stderr.trim().split(/\r?\n/).length : 0,
      stdoutLineCount: stdout.trim() ? stdout.trim().split(/\r?\n/).length : 0,
      timedOut: result.timedOut,
    }),
  ]);
  return stageResult;
}

async function runCliLane(runRoot: string): Promise<StageResult[]> {
  const installOrBuild = await runCliStage(runRoot, {
    args: ["scripts/run-node.mjs", "--version"],
    classify: (result) => {
      const output = `${result.stdout}\n${result.stderr}`;
      const hasVersion = /OpenClaw\s+\d{4}\.\d+\.\d+/.test(output);
      return {
        classification: hasVersion ? "cli-version-ok" : "cli-version-unexpected",
        reason: hasVersion
          ? "CLI dev runner executed and reported the OpenClaw version."
          : "CLI dev runner returned without the expected OpenClaw version text.",
        status: result.exitCode === 0 && hasVersion ? "pass" : "automation-issue",
      };
    },
    stage: "install-or-build",
    timeoutMs: 30_000,
  });
  const gatewayStatus = await runCliStage(runRoot, {
    args: [
      "scripts/run-node.mjs",
      "gateway",
      "status",
      "--json",
      "--url",
      "ws://127.0.0.1:1",
      "--timeout",
      "1000",
    ],
    classify: (result, parsed) => {
      const rpc = parsed?.rpc as Record<string, unknown> | undefined;
      const rpcError = typeof rpc?.error === "string" ? rpc.error : "";
      const reportsRecovery = Boolean(parsed?.gateway) && /ECONNREFUSED|connect/i.test(rpcError);
      return {
        classification: reportsRecovery
          ? "gateway-status-recovery-json"
          : "gateway-status-unexpected",
        reason: reportsRecovery
          ? "CLI gateway status produced bounded JSON showing a recoverable connection error against an isolated probe URL."
          : "CLI gateway status did not produce the expected recoverable gateway-status JSON.",
        status: result.exitCode === 0 && reportsRecovery ? "pass" : "automation-issue",
      };
    },
    stage: "error-state",
    timeoutMs: 15_000,
  });
  return [installOrBuild, gatewayStatus];
}

async function writeStageArtifacts(
  stageDir: string,
  result: StageResult,
  validation: Record<string, unknown>,
): Promise<void> {
  await Promise.all([
    writeJson(path.join(stageDir, "stage.json"), {
      schemaVersion: 1,
      ...result,
    }),
    writeJson(path.join(stageDir, "machine-validation.json"), {
      schemaVersion: 1,
      status: result.status,
      ...validation,
    }),
  ]);
}

async function writeRunFiles(
  options: RunnerOptions,
  runRoot: string,
  summary: RunSummary,
  cells: MatrixCell[],
  preflightResult: unknown,
): Promise<void> {
  const counts = countStatuses(cells);
  const generatedAt = new Date().toISOString();
  const releaseLedger = {
    schemaVersion: 1,
    generatedAt,
    project: "OpenClaw",
    release: {
      branch: summary.branch,
      dirty: summary.dirty,
      gitSha: summary.gitSha,
      key: `${summary.branch || "unknown"}@${summary.gitSha.slice(0, 12)}`,
      runId: summary.runId,
    },
    run: summary,
    counts,
    issues: {
      total: countIssueStatuses(counts),
      fail: counts.fail,
      blocked: counts.blocked,
      environmentIssue: counts["environment-issue"],
      automationIssue: counts["automation-issue"],
    },
    notes: [],
  };
  const manifest = {
    schemaVersion: 1,
    artifactRoot: runRoot,
    generatedAt,
    matrixPath: "matrix.json",
    project: "OpenClaw",
    qaEvidencePath: "qa-evidence.json",
    run: summary,
    releaseLedgerPath: "release-ledger.json",
    scorecardPath: "scorecard.md",
    statusTaxonomy: [
      "pass",
      "fail",
      "blocked",
      "environment-issue",
      "automation-issue",
      "proof-gap",
      "not-applicable",
      "fixed-in-pr",
    ],
  };
  const matrix = {
    schemaVersion: 1,
    cells,
    counts,
    generatedAt,
    run: summary,
    stages,
    surfaces,
  };
  const qaEvidence = buildUxMatrixQaEvidence({ cells, generatedAt, summary });
  await Promise.all([
    writeJson(path.join(runRoot, "manifest.json"), manifest),
    writeJson(path.join(runRoot, "matrix.json"), matrix),
    writeJson(path.join(runRoot, "qa-evidence.json"), qaEvidence),
    writeJson(path.join(runRoot, "release-ledger.json"), releaseLedger),
    writeText(path.join(runRoot, "scorecard.md"), renderScorecard(summary, cells, preflightResult)),
    writeJson(path.join(options.artifactBase, "latest-run.json"), {
      artifactRoot: runRoot,
      manifest: path.join(runRoot, "manifest.json"),
      matrix: path.join(runRoot, "matrix.json"),
      qaEvidence: path.join(runRoot, "qa-evidence.json"),
      runId: summary.runId,
    }),
  ]);
  await replaceLatestSymlink(options.artifactBase, runRoot);
}

async function replaceLatestSymlink(artifactBase: string, runRoot: string): Promise<void> {
  const latest = path.join(artifactBase, "latest");
  await unlink(latest).catch(() => undefined);
  await symlink(runRoot, latest, "dir").catch(() => undefined);
}

function renderScorecard(
  summary: RunSummary,
  cells: MatrixCell[],
  preflightResult: unknown,
): string {
  const counts = countStatuses(cells);
  const lines = [
    "# OpenClaw UX Matrix MVP",
    "",
    `- Run: \`${summary.runId}\``,
    `- Status: \`${summary.status}\``,
    `- Branch: \`${summary.branch}\``,
    `- SHA: \`${summary.gitSha}\``,
    `- Dirty checkout: \`${summary.dirty}\``,
    "",
    "## Status Counts",
    "",
    ...Object.entries(counts).map(([status, count]) => `- \`${status}\`: ${count}`),
    "",
    "## MVP Execution",
    "",
    "- Executed: `web-ui` / `first-run` and `gateway-connected-healthy`.",
    "- Executed: `cli` / `install-or-build` and `error-state`.",
    "- Not executed: Android, iOS, iPad, macOS, TUI, watchOS, and Matrix live cells are represented as proof gaps for future serial lanes.",
    "- Memory rule: this MVP does not launch Android, Apple simulators, Docker, or a real gateway.",
    "",
    "## Preflight",
    "",
    "```json",
    JSON.stringify(preflightResult, null, 2),
    "```",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function runMatrix(options: RunnerOptions): Promise<RunSummary> {
  await mkdir(options.artifactBase, { recursive: true });
  const git = await gitInfo();
  const runId = `${utcStamp()}-${git.sha.slice(0, 10)}`;
  const runRoot = path.join(options.artifactBase, runId);
  await mkdir(runRoot, { recursive: true });
  let cells = createInitialCells();
  const summary: RunSummary = {
    artifactRoot: runRoot,
    branch: git.branch,
    dirty: git.dirty,
    gitSha: git.sha,
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  activeRunSnapshot = summary;
  const commands = [
    `node --import tsx scripts/ux-matrix/dashboard.ts --once --recording-ms ${options.recordingMs}`,
    `node --import tsx scripts/ux-matrix/dashboard.ts --port <port> --recording-ms ${options.recordingMs}`,
    `POST /api/runs`,
    "MVP lane: mocked Control UI via ui/src/test-helpers/control-ui-e2e.ts",
    "MVP lane: CLI version and isolated gateway status recovery via scripts/run-node.mjs",
  ];
  await writeText(path.join(runRoot, "commands.txt"), `${commands.join("\n")}\n`);
  const preflightResult = await preflight(runRoot);
  await writeRunFiles(options, runRoot, summary, cells, preflightResult);
  const webResults = await runWebUiLane(runRoot, options.recordingMs);
  for (const result of webResults) {
    cells = replaceCell(cells, result);
  }
  await writeRunFiles(options, runRoot, summary, cells, preflightResult);
  const cliResults = await runCliLane(runRoot);
  for (const result of cliResults) {
    cells = replaceCell(cells, result);
  }
  const results = [...webResults, ...cliResults];
  const hasFailure = results.some((result) =>
    ["fail", "automation-issue", "environment-issue", "blocked"].includes(result.status),
  );
  summary.endedAt = new Date().toISOString();
  summary.status = hasFailure ? "fail" : "pass";
  await writeRunFiles(options, runRoot, summary, cells, preflightResult);
  activeRunSnapshot = summary;
  return summary;
}

async function loadLatestRun(options: RunnerOptions) {
  if (activeRunSnapshot) {
    return readRunPayload(options, activeRunSnapshot.artifactRoot, activeRunSnapshot);
  }
  try {
    const latest = JSON.parse(
      await readFile(path.join(options.artifactBase, "latest-run.json"), "utf8"),
    ) as { artifactRoot?: string };
    if (!latest.artifactRoot) {
      return { active: false, latest: null };
    }
    return readRunPayload(options, latest.artifactRoot);
  } catch {
    return { active: Boolean(activeRun), latest: null };
  }
}

async function loadRunHistory(options: RunnerOptions): Promise<RunHistoryEntry[]> {
  const entries = await readdir(options.artifactBase, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runRoot = path.join(options.artifactBase, entry.name);
        const [manifest, matrix, qaEvidence] = await Promise.all([
          readJsonIfExists(path.join(runRoot, "manifest.json")),
          readJsonIfExists(path.join(runRoot, "matrix.json")),
          readJsonIfExists(path.join(runRoot, "qa-evidence.json")),
        ]);
        const run = (manifest as { run?: RunSummary } | null)?.run;
        if (!run?.runId) {
          return null;
        }
        const readableMatrix =
          applyQaEvidenceToMatrix(matrix, qaEvidence) ?? matrixFromQaEvidence(qaEvidence, run);
        const historyEntry: RunHistoryEntry = Object.assign({}, run);
        historyEntry.counts = (
          readableMatrix as { counts?: Partial<Record<CellStatus, number>> } | null
        )?.counts;
        return historyEntry;
      }),
  );
  return runs
    .filter((run): run is RunHistoryEntry => run !== null)
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function isSafeRunId(value: string): boolean {
  return /^[0-9TZ-]+-[a-f0-9]{10}$/.test(value);
}

async function readRunPayload(
  _options: RunnerOptions,
  runRoot: string,
  fallbackSummary?: RunSummary,
) {
  const [manifest, matrix, defaultQaEvidence] = await Promise.all([
    readJsonIfExists(path.join(runRoot, "manifest.json")),
    readJsonIfExists(path.join(runRoot, "matrix.json")),
    readJsonIfExists(path.join(runRoot, "qa-evidence.json")),
  ]);
  const qaEvidencePath =
    typeof (manifest as { qaEvidencePath?: unknown } | null)?.qaEvidencePath === "string"
      ? (manifest as { qaEvidencePath: string }).qaEvidencePath
      : "qa-evidence.json";
  const qaEvidence =
    qaEvidencePath === "qa-evidence.json"
      ? defaultQaEvidence
      : ((await readJsonIfExists(path.join(runRoot, qaEvidencePath))) ?? defaultQaEvidence);
  const run = (manifest as { run?: RunSummary } | null)?.run ?? fallbackSummary;
  const readableMatrix =
    applyQaEvidenceToMatrix(matrix, qaEvidence) ?? matrixFromQaEvidence(qaEvidence, run);
  return {
    active: Boolean(activeRun),
    latest: {
      manifest,
      matrix: readableMatrix,
      qaEvidence,
      run,
    },
  };
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(response: ServerResponse, statusCode: number, value: string, type: string): void {
  response.writeHead(statusCode, { "content-type": type });
  response.end(value);
}

async function serveArtifact(
  requestPath: string,
  response: ServerResponse,
  artifactBase: string,
): Promise<void> {
  const rawRelative = decodeURIComponent(requestPath.replace(/^\/artifacts\//, ""));
  const candidate = path.resolve(artifactBase, rawRelative);
  const realBase = await realpath(artifactBase);
  const realCandidate = await realpath(candidate).catch(() => "");
  if (
    !realCandidate ||
    (!realCandidate.startsWith(`${realBase}${path.sep}`) && realCandidate !== realBase)
  ) {
    sendJson(response, 404, { error: "artifact not found" });
    return;
  }
  const fileStat = await stat(realCandidate).catch(() => null);
  if (!fileStat?.isFile()) {
    sendJson(response, 404, { error: "artifact not found" });
    return;
  }
  const content = await readFile(realCandidate);
  response.writeHead(200, { "content-type": contentType(realCandidate) });
  response.end(content);
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".md") || filePath.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  if (filePath.endsWith(".png")) {
    return "image/png";
  }
  if (filePath.endsWith(".gif")) {
    return "image/gif";
  }
  if (filePath.endsWith(".webm")) {
    return "video/webm";
  }
  return "application/octet-stream";
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/") {
    sendText(response, 200, dashboardHtml(), "text/html; charset=utf-8");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/latest") {
    sendJson(response, 200, await loadLatestRun(options));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, {
      active: Boolean(activeRun),
      runs: await loadRunHistory(options),
    });
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/run/")) {
    const runId = decodeURIComponent(url.pathname.replace(/^\/api\/run\//, ""));
    if (!isSafeRunId(runId)) {
      sendJson(response, 404, { error: "run not found" });
      return;
    }
    const runRoot = path.join(options.artifactBase, runId);
    const payload = await readRunPayload(options, runRoot);
    if (!payload.latest.run) {
      sendJson(response, 404, { error: "run not found" });
      return;
    }
    sendJson(response, 200, payload);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
    await serveArtifact(url.pathname, response, options.artifactBase);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/runs") {
    if (activeRun) {
      sendJson(response, 409, { error: "run already active", run: activeRunSnapshot });
      return;
    }
    activeRun = runMatrix(options)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        activeRunSnapshot = activeRunSnapshot
          ? { ...activeRunSnapshot, endedAt: new Date().toISOString(), status: "fail" }
          : null;
        throw new Error(message);
      })
      .finally(() => {
        activeRun = null;
      });
    sendJson(response, 202, { status: "started" });
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw UX Matrix</title>
    <style>
      :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; background: #f7f7f6; color: #111111; --bg: #f7f7f6; --chrome: rgba(255,255,255,.9); --rail: #fbfbfa; --panel: #ffffff; --surface: #fafafa; --surface-soft: #f5f5f3; --surface-hover: #f0f0ee; --line: rgba(17,17,17,.16); --line-soft: rgba(17,17,17,.09); --ink: #111111; --ink-soft: #555555; --ink-faint: #8a8a86; --accent: #111111; --green: #2f7d55; --amber: #9a6a24; --red: #b54747; --blue: #3d6476; --mono: "SF Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--bg); overflow: hidden; }
      body::before { content: none; }
      .shell { height: 100vh; min-height: 0; display: grid; grid-template-columns: 214px minmax(0, 1fr); position: relative; overflow: hidden; }
      .nav { background: var(--rail); border-right: 1px solid var(--line-soft); padding: 20px 12px; display: grid; align-content: start; gap: 24px; }
      .brand { display: grid; gap: 4px; padding: 2px 10px 14px; border-bottom: 1px solid var(--line-soft); }
      .brand strong { font-size: 16px; line-height: 1; font-weight: 690; }
      .brand span { color: var(--ink-faint); font-size: 12px; }
      .nav button { color: var(--ink-soft); text-decoration: none; display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 7px; font-size: 13px; border: 1px solid transparent; background: transparent; min-width: 0; width: 100%; font-weight: 560; letter-spacing: 0; }
      .nav button.active { background: #ffffff; border-color: var(--line-soft); color: var(--ink); box-shadow: inset 2px 0 0 var(--accent); }
      .nav button:not(.active):hover { background: #f2f2f0; color: var(--ink); }
      .content { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); }
      .topbar { min-height: 66px; border-bottom: 1px solid var(--line-soft); background: var(--chrome); backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2); display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 24px; position: sticky; top: 0; z-index: 3; }
      .project { display: flex; align-items: center; gap: 12px; min-width: 0; }
      select { background: #ffffff; color: var(--ink); border: 1px solid var(--line-soft); border-radius: 7px; padding: 8px 34px 8px 10px; font-weight: 560; }
      .run-state { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
      button { border: 1px solid var(--line-soft); background: #ffffff; color: var(--ink); border-radius: 7px; padding: 9px 13px; font-weight: 590; cursor: pointer; min-width: 112px; font: inherit; letter-spacing: 0; transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease; }
      button:hover { background: var(--surface-hover); border-color: var(--line); transform: translateY(-1px); box-shadow: 0 1px 2px rgba(17,17,17,.04); }
      #run, #run-inline { border-color: #111111; background: #111111; color: #ffffff; }
      button:disabled { opacity: 0.55; cursor: wait; }
      main { min-width: 0; min-height: 0; padding: 22px 24px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(390px, 440px); gap: 18px; align-items: start; overflow: hidden; }
      .main-stack { min-width: 0; min-height: 0; display: grid; gap: 18px; overflow: auto; }
      .panel { border: 1px solid var(--line-soft); border-radius: 10px; background: var(--panel); overflow: hidden; box-shadow: 0 1px 2px rgba(17,17,17,.03); }
      .panel-head { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); background: #ffffff; }
      h1, h2, h3 { margin: 0; letter-spacing: 0; }
      h1 { font-size: 17px; font-weight: 660; }
      h2 { font-size: 14px; font-weight: 650; }
      h3 { font-size: 13px; font-weight: 620; }
      .muted { color: var(--ink-faint); font-size: 12px; }
      .metric-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0; border-bottom: 1px solid var(--line-soft); }
      .metric { background: transparent; padding: 15px; min-width: 0; border-right: 1px solid var(--line-soft); }
      .metric .label { color: var(--ink-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0; }
      .metric .value { margin-top: 5px; font-size: 14px; overflow-wrap: anywhere; font-weight: 560; }
      .timeline { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; padding: 12px 14px; }
      .timeline-step { border: 1px solid var(--line-soft); border-radius: 8px; padding: 10px; background: var(--surface); min-height: 58px; }
      .view-grid { display: grid; gap: 16px; }
      .command-panel { display: grid; gap: 16px; padding: 16px; }
      .app-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr); gap: 12px; align-items: stretch; }
      .hero-copy { border: 1px solid var(--line-soft); border-radius: 10px; background: var(--surface); padding: 18px; display: grid; gap: 13px; align-content: space-between; }
      .hero-copy strong { font-size: 24px; line-height: 1.05; max-width: 780px; font-weight: 690; }
      .hero-kicker { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
      .run-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .secondary-button { min-width: 0; border-color: var(--line-soft); background: #ffffff; color: var(--ink-soft); }
      .count-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .count-card { border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); padding: 12px; min-width: 0; }
      .count-card b { display: block; font-size: 22px; line-height: 1; font-weight: 690; }
      .score-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .score-card { border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); padding: 12px; display: grid; gap: 9px; min-height: 92px; }
      .score-card strong { font-size: 18px; line-height: 1.06; }
      .score-bar { height: 4px; border-radius: 999px; background: #e7e7e3; overflow: hidden; }
      .score-fill { height: 100%; border-radius: 999px; background: var(--green); width: 0%; }
      .score-fill.amber { background: var(--amber); }
      .score-fill.blue { background: var(--blue); }
      .score-fill.red { background: var(--red); }
      .lane-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
      .matrix-first { display: grid; gap: 12px; padding: 14px; }
      .summary-strip { display: grid; grid-template-columns: minmax(0, 1.35fr) repeat(4, minmax(96px, .3fr)); gap: 8px; }
      .summary-lead { border: 1px solid var(--line-soft); border-radius: 10px; background: var(--surface); padding: 13px 14px; display: grid; gap: 8px; }
      .summary-lead strong { font-size: 18px; line-height: 1.08; font-weight: 650; }
      .summary-lead .run-actions { gap: 6px; }
      .summary-lead .run-actions button { padding: 7px 10px; min-width: 0; font-size: 12px; }
      .section-note { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--ink-faint); font-size: 12px; }
      .mode-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 3px; border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface-soft); }
      .mode-tabs button { min-width: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ink-soft); padding: 9px 10px; }
      .mode-tabs button.active { background: #ffffff; color: var(--ink); box-shadow: 0 1px 2px rgba(17,17,17,.04); }
      .workspace-panel { min-height: 0; display: grid; gap: 12px; }
      .workspace-panel .matrix-wrap { max-height: min(56vh, 620px); border: 1px solid var(--line-soft); border-radius: 10px; }
      .workspace-panel .lane-board { max-height: min(56vh, 620px); overflow: auto; padding-right: 2px; }
      .workspace-panel .release-list { max-height: min(56vh, 620px); overflow: auto; padding: 0; }
      .lane-card { border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); padding: 13px; display: grid; gap: 10px; min-width: 0; }
      .lane-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
      .lane-meter { display: grid; grid-template-columns: repeat(15, minmax(4px, 1fr)); gap: 3px; }
      .lane-dot { height: 8px; border-radius: 999px; background: #e5e5e1; }
      .lane-dot.pass { background: var(--green); box-shadow: none; }
      .lane-dot.fail, .lane-dot.automation-issue { background: var(--red); }
      .lane-dot.environment-issue, .lane-dot.blocked { background: var(--amber); }
      .insight-grid { display: grid; grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr); gap: 12px; }
      .insight-card { border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); padding: 13px; display: grid; gap: 10px; min-width: 0; }
      .action-list { display: grid; gap: 8px; }
      .action-item { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; padding: 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--surface); }
      .stage-board { display: grid; gap: 8px; padding: 14px; }
      .stage-row { display: grid; grid-template-columns: minmax(170px, 0.9fr) minmax(220px, 1.2fr) minmax(180px, 0.9fr) minmax(140px, 0.6fr); gap: 10px; align-items: center; border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); color: var(--ink); padding: 12px; text-align: left; }
      .status-strip { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 3px; }
      .status-block { height: 24px; display: grid; place-items: center; border-radius: 6px; background: #e8e8e4; color: var(--ink-faint); font-size: 10px; font-weight: 650; }
      .status-block.pass { background: #e6f2eb; color: #276947; }
      .status-block.fail, .status-block.automation-issue { background: #f7e7e5; color: #9c3939; }
      .status-block.environment-issue, .status-block.blocked { background: #f3eadb; color: #805716; }
      .status-block.proof-gap { background: #e8e8e4; color: var(--ink-faint); }
      .workbench-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 0.75fr); gap: 12px; padding: 14px; }
      .workbench-grid .stage-row { grid-template-columns: minmax(130px, 0.45fr) minmax(0, 1fr); align-items: start; }
      .workbench-grid .stage-row > div:nth-child(3), .workbench-grid .stage-row > div:nth-child(4) { grid-column: 1 / -1; }
      .proof-inventory { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .proof-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
      .proof-preview { border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); color: var(--ink); padding: 10px; min-width: 0; display: grid; gap: 9px; text-align: left; }
      .proof-preview:hover { border-color: var(--line); background: var(--surface-hover); }
      .proof-preview.selected { border-color: #111111; box-shadow: 0 0 0 1px #111111; }
      .preview-media { min-height: 142px; display: grid; align-items: center; background: #f3f3f1; border: 1px solid var(--line-soft); border-radius: 8px; overflow: hidden; }
      .preview-media img, .preview-media video { border: 0; border-radius: 0; max-height: 220px; }
      .terminal-proof { background: #f3f3f1; border: 1px solid var(--line-soft); border-radius: 8px; color: #333333; font-family: var(--mono); font-size: 11px; min-height: 142px; max-height: 220px; overflow: auto; padding: 10px; white-space: pre-wrap; }
      .split-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; padding: 14px; }
      .history-list, .evidence-grid, .report-grid, .release-list { display: grid; gap: 10px; padding: 14px; }
      .history-row, .evidence-card, .report-card, .journey-card, .device-card { background: var(--surface); border: 1px solid var(--line-soft); border-radius: 9px; color: var(--ink); padding: 12px; min-width: 0; text-align: left; }
      .history-row { display: grid; grid-template-columns: minmax(160px, 1fr) 88px minmax(180px, 1fr) minmax(180px, 1fr); gap: 12px; align-items: center; }
      .release-row { width: 100%; min-height: 104px; display: grid; grid-template-columns: minmax(145px, .85fr) minmax(86px, .35fr) minmax(120px, .72fr) minmax(0, 1fr); gap: 12px; align-items: start; border: 1px solid var(--line-soft); border-radius: 9px; background: var(--surface); color: var(--ink); padding: 12px; text-align: left; overflow: hidden; line-height: 1.15; }
      .release-row > div { min-width: 0; overflow-wrap: anywhere; }
      .release-note { border-left: 2px solid var(--line-soft); padding-left: 10px; color: var(--ink-soft); }
      .history-row:hover, .release-row:hover, .evidence-card:hover { border-color: var(--line); background: var(--surface-hover); }
      .history-row.selected, .release-row.selected, .evidence-card.selected { border-color: #111111; box-shadow: 0 0 0 1px #111111; }
      .evidence-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .evidence-card { display: grid; gap: 10px; }
      .evidence-card .preview-media { min-height: 180px; }
      .thumbs { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .thumbs img, .thumbs video { max-height: 170px; }
      .kv { display: grid; gap: 6px; font-size: 12px; color: var(--ink-soft); }
      .kv-row { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-soft); padding-bottom: 4px; }
      .kv-row span:last-child { text-align: right; overflow-wrap: anywhere; }
      .validation-summary { border: 1px solid var(--line-soft); border-radius: 8px; background: var(--surface); color: var(--ink-soft); display: grid; gap: 5px; font-size: 12px; padding: 10px; }
      .validation-summary div { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line-soft); padding-bottom: 4px; }
      .validation-summary div:last-child { border-bottom: 0; padding-bottom: 0; }
      .validation-summary span:first-child { flex: 0 0 86px; }
      .validation-summary span:last-child { text-align: right; overflow-wrap: anywhere; }
      .view-copy { padding: 14px; color: var(--ink-soft); max-width: 880px; line-height: 1.5; }
      .matrix-wrap { overflow: auto; max-height: calc(100vh - 300px); }
      table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; min-width: 980px; }
      th, td { border-right: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); padding: 8px; vertical-align: top; }
      th { background: #f2f2f0; position: sticky; top: 0; z-index: 2; color: var(--ink-soft); }
      td:first-child, th:first-child { position: sticky; left: 0; z-index: 2; background: #fafafa; min-width: 190px; }
      tr:hover td { background: #f4f4f2; }
      tr:hover td:first-child { background: #f4f4f2; }
      .cell-button { width: 100%; min-height: 78px; display: grid; gap: 6px; align-content: start; text-align: left; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; padding: 8px; cursor: pointer; }
      .cell-button:hover, .cell-button.selected { border-color: var(--line); background: #f2f2f0; }
      .status { display: inline-flex; width: max-content; border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 680; text-transform: lowercase; letter-spacing: 0; }
      .pass { background: #e6f2eb; color: #276947; }
      .fail, .automation-issue { background: #f7e7e5; color: #9c3939; }
      .environment-issue, .blocked { background: #f3eadb; color: #805716; }
      .proof-gap { background: #e8e8e4; color: #6b6b66; }
      .not-applicable { background: #eeeeeb; color: var(--ink-faint); }
      .fixed-in-pr { background: #e5ecef; color: #3d6476; }
      .proofs { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; }
      a { color: var(--ink); text-underline-offset: 3px; }
      .inspector { position: sticky; top: 86px; display: grid; gap: 12px; max-height: calc(100vh - 106px); min-width: 0; overflow: auto; }
      .inspector-body { padding: 15px; display: grid; gap: 12px; min-width: 0; }
      .inspector-body > div { min-width: 0; overflow-wrap: anywhere; }
      .detail-title { display: grid; gap: 3px; }
      .detail-title strong { font-size: 18px; overflow-wrap: anywhere; }
      .artifact-media { display: grid; gap: 10px; min-width: 0; overflow: hidden; }
      .artifact-media img, .artifact-media video { max-width: 100%; height: auto; }
      img, video { width: 100%; max-height: 360px; object-fit: contain; background: #f3f3f1; border: 1px solid var(--line-soft); border-radius: 8px; }
      pre { margin: 0; white-space: pre-wrap; overflow: auto; max-height: 220px; background: #f3f3f1; border-radius: 8px; padding: 10px; border: 1px solid var(--line-soft); color: #333333; font-size: 12px; font-family: var(--mono); }
      .raw-excerpt { max-height: 150px; }
      .link-list { display: flex; flex-wrap: wrap; gap: 8px; }
      .pill { border: 1px solid var(--line-soft); border-radius: 999px; padding: 4px 8px; color: var(--ink-soft); font-size: 12px; background: #ffffff; }
      .path-text { overflow-wrap: anywhere; word-break: break-word; }
      @media (max-width: 1080px) {
        .shell { grid-template-columns: 1fr; }
        .nav { display: flex; align-items: center; gap: 8px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 10px; position: sticky; top: 0; z-index: 4; }
        .brand { min-width: 170px; padding: 0 8px; }
        .nav button { width: auto; flex: 0 0 auto; min-width: auto; }
        .topbar { position: static; }
        main { grid-template-columns: 1fr; }
        body { overflow: auto; }
        .shell { height: auto; min-height: 100vh; overflow: visible; }
        main { overflow: visible; }
        .main-stack { overflow: visible; }
        .inspector { position: static; max-height: none; }
        .app-hero, .insight-grid, .workbench-grid { grid-template-columns: 1fr; }
        .score-grid, .proof-inventory, .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .summary-lead { grid-column: 1 / -1; }
        .stage-row { grid-template-columns: 1fr; }
        .release-row { grid-template-columns: 1fr; }
      }
      @media (max-width: 620px) {
        .topbar { align-items: stretch; flex-direction: column; }
        .run-state { justify-content: flex-start; }
        .score-grid, .count-grid, .proof-inventory { grid-template-columns: 1fr; }
        .history-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <nav class="nav" aria-label="UX Matrix navigation">
        <div class="brand">
          <strong>OpenClaw</strong>
          <span>UX Matrix Command Center</span>
        </div>
        <button class="active" data-view="runs">Overview</button>
        <button data-view="matrix">Matrix</button>
        <button data-view="journeys">Stages</button>
        <button data-view="validation">Validation</button>
        <button data-view="evidence">Evidence</button>
        <button data-view="devices">Platforms</button>
        <button data-view="reports">History</button>
      </nav>
      <div class="content">
        <header class="topbar">
          <div class="project">
            <select aria-label="Project selector"><option>OpenClaw</option></select>
            <div>
              <h1>Local E2E UX Matrix</h1>
              <div class="muted">Serial proof runner for product journey evidence</div>
            </div>
          </div>
          <div class="run-state">
            <span class="pill" id="runner-state">idle</span>
            <span class="pill">serial lanes</span>
            <span class="pill">memory guarded</span>
            <button id="run">Run Matrix</button>
          </div>
        </header>
        <main>
          <div class="main-stack" id="primary-view"></div>
          <aside class="panel inspector">
            <div class="panel-head">
              <h2>Stage Detail</h2>
              <span class="muted" id="selected-label">No stage selected</span>
            </div>
            <div class="inspector-body" id="inspector"></div>
          </aside>
        </main>
      </div>
    </div>
    <script>
      const stages = ${JSON.stringify(stages)};
      const surfaces = ${JSON.stringify(surfaces)};
      const runButton = document.getElementById("run");
      let selectedKey = "web-ui:first-run";
      let selectedRunId = null;
      let selectedView = "runs";
      let overviewMode = "matrix";
      let latestPayload = null;
      let historyPayload = { runs: [] };
      function artifactUrl(runId, rel) {
        return rel ? "/artifacts/" + encodeURIComponent(runId) + "/" + rel.split("/").map(encodeURIComponent).join("/") : "";
      }
      function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
      }
      function sanitizeUiText(value) {
        return String(value ?? "")
          .replace(/\\/Users\\/[^\\s"',]+/g, "[home]")
          .replace(/\\/Applications\\/Google Chrome[^\\s"',]+/g, "[browser-app]")
          .replace(/\\/private\\/var\\/folders\\/[^\\s"',]+/g, "[browser-cache]")
          .replace(/\\/tmp\\/openclaw\\/[^\\s"',]+/g, "[openclaw-log]")
          .replace(/(Authorization:\\s*Bearer\\s+)[^\\s"']+/gi, "$1[redacted]")
          .replace(/(--token\\s+)[^\\s"']+/gi, "$1[redacted]")
          .replace(/("token"\\s*:\\s*")[^"]+(")/gi, "$1[redacted]$2")
          .replace(/("apiKey"\\s*:\\s*")[^"]+(")/gi, "$1[redacted]$2")
          .replace(/\\b[a-f0-9]{32,}\\b/gi, (match) => match.slice(0, 8) + "…");
      }
      function statusPill(status) {
        return '<span class="status ' + escapeHtml(status || "proof-gap") + '">' + escapeHtml(status || "proof-gap") + '</span>';
      }
      function currentRun() {
        const latest = latestPayload?.latest || {};
        return latest.run || latest.manifest?.run || {};
      }
      function currentMatrix() {
        return latestPayload?.latest?.matrix || null;
      }
      function currentQaEvidence() {
        return latestPayload?.latest?.qaEvidence || null;
      }
      function currentCells() {
        return currentMatrix()?.cells || [];
      }
      function executedCells() {
        return currentCells().filter((cell) => cell.status !== "proof-gap");
      }
      function countsLine(counts) {
        if (!counts) return "no counts";
        return ["pass", "fail", "blocked", "environment-issue", "automation-issue", "proof-gap"].map((key) => key + " " + (counts[key] || 0)).join(" · ");
      }
      function issueCount(counts) {
        return (counts?.fail || 0) + (counts?.blocked || 0) + (counts?.["environment-issue"] || 0) + (counts?.["automation-issue"] || 0);
      }
      function pct(value, total) {
        return total > 0 ? Math.round((value / total) * 100) : 0;
      }
      function clampPct(value) {
        return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
      }
      function stageLabel(stageId) {
        return stages.find((stage) => stage.id === stageId)?.label || stageId;
      }
      function surfaceLabel(surfaceId) {
        return surfaces.find((surface) => surface.id === surfaceId)?.label || surfaceId;
      }
      function readinessLabel(readiness) {
        return {
          "now-local": "Local",
          "now-ci": "CI",
          "later-heavy": "Heavy",
          "manual-only": "Manual"
        }[readiness] || readiness;
      }
      function proofInventory(cells) {
        return cells.reduce((totals, cell) => {
          const proof = cell.proof || {};
          totals.screenshots += proof.screenshot ? 1 : 0;
          totals.gifs += proof.gif ? 1 : 0;
          totals.videos += proof.recording ? 1 : 0;
          totals.logs += proof.logs?.length || 0;
          totals.validations += proof.machineValidation ? 1 : 0;
          totals.mediaCells += proof.screenshot || proof.gif || proof.recording ? 1 : 0;
          totals.logCells += proof.logs?.length ? 1 : 0;
          return totals;
        }, { gifs: 0, logCells: 0, logs: 0, mediaCells: 0, screenshots: 0, validations: 0, videos: 0 });
      }
      function runAnalysis() {
        const matrix = currentMatrix();
        const cells = matrix?.cells || [];
        const executed = cells.filter((cell) => cell.status !== "proof-gap");
        const counts = matrix?.counts || {};
        const issues = (counts.fail || 0) + (counts.blocked || 0) + (counts["environment-issue"] || 0) + (counts["automation-issue"] || 0);
        const nowLocal = cells.filter((cell) => cell.automation === "now-local");
        const nowLocalExecuted = nowLocal.filter((cell) => cell.status !== "proof-gap");
        const inventory = proofInventory(cells);
        return {
          cells,
          counts,
          executed,
          inventory,
          issues,
          nowLocal,
          nowLocalExecuted,
          proofCoverage: pct(executed.length, cells.length),
          localCoverage: pct(nowLocalExecuted.length, nowLocal.length),
          validationCoverage: pct(inventory.validations, executed.length)
        };
      }
      function statusClassForStage(cells) {
        if (cells.some((cell) => ["fail", "blocked", "environment-issue", "automation-issue"].includes(cell.status))) return "blocked";
        if (cells.some((cell) => cell.status === "pass")) return "pass";
        return "proof-gap";
      }
      function nextActionForStage(stageCells) {
        const runnableGap = stageCells.find((cell) => cell.status === "proof-gap" && cell.automation === "now-local");
        if (runnableGap) return "Queue " + surfaceLabel(runnableGap.surface);
        const heavyGap = stageCells.find((cell) => cell.status === "proof-gap" && cell.automation === "later-heavy");
        if (heavyGap) return "Plan " + surfaceLabel(heavyGap.surface);
        return "Review evidence";
      }
      function mediaListForCell(cell) {
        const proof = cell.proof || {};
        return [
          proof.screenshot && "screenshot",
          proof.gif && "gif",
          proof.recording && "video",
          proof.machineValidation && "validation",
          proof.logs?.length && "log"
        ].filter(Boolean);
      }
      function renderScoreCard(label, value, detail, percent, colorClass = "") {
        return '<div class="score-card"><div class="muted">' + escapeHtml(label) + '</div><strong>' + escapeHtml(value) + '</strong><div class="score-bar"><div class="score-fill ' + colorClass + '" style="width:' + clampPct(percent) + '%"></div></div><div class="muted">' + escapeHtml(detail) + '</div></div>';
      }
      function renderActionItem(label, value) {
        return '<div class="action-item"><span class="muted">' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
      }
      async function refresh() {
        const [historyRes, runRes] = await Promise.all([
          fetch("/api/runs"),
          fetch(selectedRunId ? "/api/run/" + encodeURIComponent(selectedRunId) : "/api/latest")
        ]);
        historyPayload = await historyRes.json();
        let payload = runRes.ok ? await runRes.json() : null;
        if (!payload?.latest?.run) {
          payload = await fetch("/api/latest").then((res) => res.json());
          selectedRunId = null;
        }
        latestPayload = payload;
        const run = currentRun();
        if (!selectedRunId && run.runId) {
          selectedRunId = run.runId;
        }
        runButton.disabled = Boolean(payload.active);
        document.getElementById("runner-state").textContent = payload.active ? "running" : (run.status || "idle");
        renderNav();
        renderView();
        renderInspector();
      }
      function renderNav() {
        document.querySelectorAll(".nav button[data-view]").forEach((node) => {
          node.classList.toggle("active", node.dataset.view === selectedView);
        });
      }
      function renderMetaPanel() {
        const run = currentRun();
        const matrix = currentMatrix();
        return '<section class="panel">' +
          '<div class="panel-head"><h2>Run Overview</h2><span class="muted">' + escapeHtml(run.runId ? "Selected run " + run.runId : "No run yet") + '</span></div>' +
          '<div class="metric-row">' + [
          ["Run status", run.status || "idle"],
          ["Run ID", run.runId || "none"],
          ["Branch", run.branch || "unknown"],
          ["SHA", run.gitSha || "unknown"],
          ["QA evidence", currentQaEvidence()?.entries?.length ?? 0],
          ["Artifact root", run.artifactRoot || "none"]
        ].map(([label, value]) => '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value path-text">' + escapeHtml(sanitizeUiText(value)) + '</div></div>').join("") + '</div>' +
          '<div class="timeline">' + renderTimelineHtml(matrix) + '</div></section>';
      }
      function renderTimelineHtml(matrix) {
        const cells = matrix?.cells || [];
        const executed = cells.filter((cell) => cell.status !== "proof-gap");
        const timeline = executed.length ? executed : cells.filter((cell) => cell.surface === "web-ui").slice(0, 4);
        return timeline.map((cell) =>
          '<button class="timeline-step" data-key="' + cell.surface + ':' + cell.stage + '">' +
          '<span class="status ' + cell.status + '">' + cell.status + '</span><br>' +
          '<strong>' + escapeHtml(cell.stage) + '</strong><br><span class="muted">' + escapeHtml(cell.surface) + '</span></button>'
        ).join("") || '<div class="muted">No timeline yet.</div>';
      }
      function bindStageButtons(root = document) {
        root.querySelectorAll("[data-key]").forEach((node) => node.addEventListener("click", () => {
          selectedKey = node.dataset.key;
          selectedView = node.dataset.openView || selectedView;
          renderNav();
          renderView();
          renderInspector();
        }));
      }
      async function selectRun(runId) {
        selectedRunId = runId;
        latestPayload = await fetch("/api/run/" + encodeURIComponent(runId)).then((res) => res.json());
        selectedKey = (executedCells()[0]?.surface && executedCells()[0]?.stage) ? executedCells()[0].surface + ":" + executedCells()[0].stage : "web-ui:first-run";
        renderView();
        renderInspector();
      }
      function renderView() {
        const host = document.getElementById("primary-view");
        if (!currentRun().runId) {
          host.innerHTML = '<section class="panel"><div class="panel-head"><h2>No runs yet</h2></div><div class="view-copy">Click Run Matrix to create the first local proof run.</div></section>';
          return;
        }
        if (selectedView === "runs") {
          host.innerHTML = renderRunCommandCenter();
          bindStageButtons(host);
          bindRunHistory(host);
          bindCommandActions(host);
          bindOverviewModes(host);
          hydrateEvidenceCards();
        } else if (selectedView === "matrix") {
          host.innerHTML = renderMetaPanel() + renderMatrixPanel();
          bindStageButtons(host);
        } else if (selectedView === "journeys") {
          host.innerHTML = renderMetaPanel() + renderJourneys();
          bindStageButtons(host);
        } else if (selectedView === "validation") {
          host.innerHTML = renderValidationWorkbench();
          bindStageButtons(host);
          hydrateEvidenceCards();
        } else if (selectedView === "evidence") {
          host.innerHTML = renderEvidenceGallery();
          bindStageButtons(host);
          hydrateEvidenceCards();
        } else if (selectedView === "devices") {
          host.innerHTML = renderDevices();
          bindStageButtons(host);
        } else if (selectedView === "reports") {
          host.innerHTML = renderReports();
          bindRunHistory(host);
          hydrateReports();
        }
      }
      function renderRunCommandCenter() {
        const run = currentRun();
        const analysis = runAnalysis();
        const issueLabel = analysis.issues ? analysis.issues + " issue cell(s)" : "No failing cells";
        return '<section class="panel"><div class="panel-head"><h2>UX Matrix</h2><span class="muted">Selected run ' + escapeHtml(run.runId || 'none') + '</span></div>' +
          '<div class="matrix-first">' +
          '<div class="summary-strip">' +
          '<div class="summary-lead"><div class="hero-kicker">' + statusPill(run.status || 'idle') + '<span class="pill">' + escapeHtml(run.branch || 'unknown branch') + '</span><span class="pill">' + escapeHtml((run.gitSha || '').slice(0, 10) || 'unknown sha') + '</span></div>' +
          '<strong>Matrix first. Proof on drilldown.</strong>' +
          '<div class="muted">The overview scores platforms and journey stages. Select any cell, platform, or stage to inspect screenshots, GIFs, validation, and logs in the detail rail.</div>' +
          '<div class="run-actions"><button id="run-inline" type="button">Run Matrix</button><button class="secondary-button" type="button" data-view-target="matrix">Open Full Matrix</button><button class="secondary-button" type="button" data-view-target="reports">Release History</button></div></div>' +
          renderCountCard("Pass", analysis.counts.pass || 0) +
          renderCountCard("Issues", analysis.issues) +
          renderCountCard("Proof gaps", analysis.counts["proof-gap"] || 0) +
          renderCountCard("Logs", analysis.inventory.logs) +
          '</div>' +
          '<div class="score-grid">' +
          renderScoreCard("Overall proof coverage", analysis.executed.length + " / " + analysis.cells.length, analysis.proofCoverage + "% of matrix cells have evidence", analysis.proofCoverage, "blue") +
          renderScoreCard("Local lane coverage", analysis.nowLocalExecuted.length + " / " + analysis.nowLocal.length, "Safe web, CLI, and TUI cells queued locally", analysis.localCoverage, "amber") +
          renderScoreCard("Machine validation", analysis.inventory.validations + " checks", analysis.validationCoverage + "% of executed cells include validation", analysis.validationCoverage) +
          renderScoreCard("Current health", issueLabel, (analysis.counts.pass || 0) + " passing proof cells", analysis.issues ? 45 : 100, analysis.issues ? "red" : "") +
          '</div>' +
          renderOverviewModeTabs() +
          renderOverviewWorkspace() +
          '</div></section>';
      }
      function renderOverviewModeTabs() {
        return '<div class="mode-tabs" aria-label="Overview mode">' +
          ["matrix", "platforms", "history"].map((mode) =>
            '<button type="button" class="' + (overviewMode === mode ? "active" : "") + '" data-overview-mode="' + mode + '">' + escapeHtml({ matrix: "Matrix", platforms: "Platforms", history: "Release history" }[mode]) + '</button>'
          ).join("") +
          '</div>';
      }
      function renderOverviewWorkspace() {
        if (overviewMode === "platforms") {
          return '<div class="workspace-panel"><div class="section-note"><h3>Platforms</h3><span>Click a platform to focus proof or gaps in the detail rail.</span></div><div class="lane-board">' + surfaces.map((surface) => renderSurfaceLane(surface)).join("") + '</div></div>';
        }
        if (overviewMode === "history") {
          return '<div class="workspace-panel"><div class="section-note"><h3>Release Ledger</h3><span>Version history, issue signals, and notes from local run artifacts.</span></div>' + renderReleaseLedger({ compact: false }) + '</div>';
        }
        return '<div class="workspace-panel"><div class="section-note"><h3>Journey Matrix</h3><span>Select any cell for proof, validation, and logs.</span></div>' + renderCompactStageMatrix() + '</div>';
      }
      function renderCompactStageMatrix() {
        const run = currentRun();
        const matrix = currentMatrix();
        return '<div class="matrix-wrap">' + renderMatrixHtml(run, matrix) + '</div>';
      }
      function renderCountCard(label, value) {
        return '<div class="count-card"><b>' + escapeHtml(value) + '</b><span class="muted">' + escapeHtml(label) + '</span></div>';
      }
      function renderSurfaceLane(surface) {
        const cells = currentCells().filter((cell) => cell.surface === surface.id);
        const executed = cells.filter((cell) => cell.status !== "proof-gap");
        const pass = cells.filter((cell) => cell.status === "pass").length;
        const first = executed[0] || cells[0];
        return '<button class="lane-card" data-key="' + escapeHtml((first?.surface || surface.id) + ':' + (first?.stage || stages[0].id)) + '" data-open-view="matrix">' +
          '<div class="lane-head"><div><h3>' + escapeHtml(surface.label) + '</h3><div class="muted">' + escapeHtml(readinessLabel(surface.readiness)) + ' lane · ' + executed.length + ' / ' + cells.length + ' proven</div></div>' +
          statusPill(executed.length ? (pass === executed.length ? "pass" : statusClassForStage(cells)) : "proof-gap") + '</div>' +
          '<div class="lane-meter">' + cells.map((cell) => '<span class="lane-dot ' + escapeHtml(cell.status) + '" title="' + escapeHtml(stageLabel(cell.stage) + ': ' + cell.status) + '"></span>').join("") + '</div>' +
          '<div class="muted">' + escapeHtml(executed.length ? "Latest proof: " + stageLabel(first.stage) : "Visible in matrix; waiting for queued proof.") + '</div>' +
          '</button>';
      }
      function renderProofPreview(run, cell) {
        const proof = cell.proof || {};
        const key = cell.surface + ':' + cell.stage;
        const media = renderProofMedia(run, cell, true);
        const info = '<div>' + statusPill(cell.status) + '</div><h3>' + escapeHtml(cell.surface + ' / ' + cell.stage) + '</h3>' +
          '<div class="muted">' + escapeHtml(cell.reason) + '</div>' +
          '<div class="link-list">' + proofLinks(run, proof) + '</div>';
        return '<button class="proof-preview ' + (key === selectedKey ? 'selected' : '') + '" data-key="' + key + '">' +
          (proof.logs?.[0] && !proof.screenshot && !proof.gif ? info + media : media + info) +
          '</button>';
      }
      function renderProofMedia(run, cell, compact) {
        const proof = cell.proof || {};
        const media = [
          proof.screenshot && '<img alt="' + escapeHtml(cell.surface + ' ' + cell.stage + ' screenshot') + '" src="' + artifactUrl(run.runId, proof.screenshot) + '" />',
          !proof.screenshot && proof.gif && '<img alt="' + escapeHtml(cell.surface + ' ' + cell.stage + ' gif') + '" src="' + artifactUrl(run.runId, proof.gif) + '" />',
          !compact && proof.recording && '<video controls src="' + artifactUrl(run.runId, proof.recording) + '"></video>'
        ].filter(Boolean).join("");
        if (media) {
          return '<div class="preview-media">' + media + '</div>';
        }
        if (proof.logs?.[0]) {
          return '<pre class="terminal-proof" data-log-rel="' + escapeHtml(proof.logs[0]) + '">Loading terminal proof...</pre>';
        }
        return '<div class="preview-media"><div class="muted">No media for this cell.</div></div>';
      }
      function renderRunHistory() {
        const runs = historyPayload.runs || [];
        return '<section class="panel"><div class="panel-head"><h2>Run History</h2><span class="muted">' + runs.length + ' local artifact runs</span></div>' +
          '<div class="history-list">' + runs.map((run) =>
            '<button class="history-row ' + (run.runId === selectedRunId ? 'selected' : '') + '" data-run-id="' + escapeHtml(run.runId) + '">' +
            '<div><strong>' + escapeHtml(run.runId) + '</strong><br><span class="muted">' + escapeHtml(run.startedAt || '') + '</span></div>' +
            '<div>' + statusPill(run.status) + '</div>' +
            '<div class="muted">' + escapeHtml(countsLine(run.counts)) + '</div>' +
            '<div class="path-text">' + escapeHtml((run.branch || 'unknown') + ' / ' + (run.gitSha || '').slice(0, 10)) + '</div>' +
            '</button>'
          ).join("") + '</div></section>';
      }
      function renderReleaseLedger(options = {}) {
        const runs = (historyPayload.runs || []).slice(0, options.compact ? 5 : 30);
        if (!runs.length) {
          return '<div class="release-list"><div class="muted">No release history yet.</div></div>';
        }
        return '<div class="release-list">' + runs.map((run) => {
          const counts = run.counts || {};
          const issues = issueCount(counts);
          const releaseVersion = (run.branch || "unknown") + " / " + String(run.gitSha || "unknown").slice(0, 10);
          const note = issues
            ? issues + " issue signal(s) in this run. Add release notes when note capture is wired."
            : "No release note attached. Run passed with no issue cells.";
          return '<button class="release-row ' + (run.runId === selectedRunId ? 'selected' : '') + '" data-run-id="' + escapeHtml(run.runId) + '">' +
            '<div><strong>' + escapeHtml(run.runId) + '</strong><br><span class="muted">' + escapeHtml(run.startedAt || '') + '</span></div>' +
            '<div>' + statusPill(run.status) + '<div class="muted">' + escapeHtml((counts.pass || 0) + ' pass · ' + (counts["proof-gap"] || 0) + ' gaps') + '</div></div>' +
            '<div><strong>' + escapeHtml(releaseVersion) + '</strong><br><span class="muted">release/version key</span></div>' +
            '<div class="release-note">' + escapeHtml(note) + '</div>' +
            '</button>';
        }).join("") + '</div>';
      }
      function bindRunHistory(root) {
        root.querySelectorAll("[data-run-id]").forEach((node) => node.addEventListener("click", () => {
          selectRun(node.dataset.runId);
        }));
      }
      function bindCommandActions(root) {
        const inlineRun = root.querySelector("#run-inline");
        if (inlineRun) {
          inlineRun.addEventListener("click", () => runButton.click());
        }
        root.querySelectorAll("[data-view-target]").forEach((node) => node.addEventListener("click", () => {
          selectedView = node.dataset.viewTarget;
          renderNav();
          renderView();
          renderInspector();
        }));
      }
      function bindOverviewModes(root) {
        root.querySelectorAll("[data-overview-mode]").forEach((node) => node.addEventListener("click", () => {
          overviewMode = node.dataset.overviewMode;
          renderView();
          renderInspector();
        }));
      }
      function renderMatrixPanel() {
        return '<section class="panel"><div class="panel-head"><h2>Journey Matrix</h2><span class="muted">Rows are stages. Columns are surfaces. Proof gaps are not product failures.</span></div><div class="matrix-wrap">' + renderMatrixHtml(currentRun(), currentMatrix()) + '</div></section>';
      }
      function renderMatrixHtml(run, matrix) {
        if (!matrix?.cells) {
          return "No runs yet.";
        }
        const byKey = new Map(matrix.cells.map((cell) => [cell.surface + ":" + cell.stage, cell]));
        let html = "<table><thead><tr><th>Journey stage</th>" + surfaces.map((surface) => "<th>" + escapeHtml(surface.label) + "</th>").join("") + "</tr></thead><tbody>";
        for (const stage of stages) {
          html += "<tr><td><strong>" + escapeHtml(stage.label) + "</strong><br><span class='muted'>" + escapeHtml(stage.id) + "</span></td>";
          for (const surface of surfaces) {
            const cell = byKey.get(surface.id + ":" + stage.id);
            const status = cell?.status || "proof-gap";
            const key = surface.id + ":" + stage.id;
            const proofTypes = cell ? mediaListForCell(cell).join(" + ") : "";
            html += "<td><button class='cell-button " + (key === selectedKey ? "selected" : "") + "' data-key='" + key + "'><span class='status " + status + "'>" + status + "</span><strong>" + escapeHtml(surface.label) + "</strong><span class='muted'>" + escapeHtml(cell?.reason || "Not run in this MVP slice.") + "</span><span class='proofs'>" + escapeHtml(proofTypes || "detail rail") + "</span></button></td>";
          }
          html += "</tr>";
        }
        return html + "</tbody></table>";
      }
      function proofLinks(run, proof) {
        return [
          proof.screenshot && ["screenshot", proof.screenshot],
          proof.gif && ["gif", proof.gif],
          proof.recording && ["video", proof.recording],
          proof.machineValidation && ["validation", proof.machineValidation],
          ...(proof.logs || []).map((log) => ["log", log])
        ].filter(Boolean).map(([label, rel]) => '<a href="' + artifactUrl(run.runId, rel) + '" target="_blank">' + escapeHtml(label) + '</a>').join("");
      }
      function validationSummaryHtml(rawText) {
        let parsed = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
        const fallbackValue = (key) => {
          const stringMatch = rawText.match(new RegExp('"' + key + '"\\\\s*:\\\\s*"([^"]+)"'));
          if (stringMatch) return stringMatch[1];
          const numberMatch = rawText.match(new RegExp('"' + key + '"\\\\s*:\\\\s*([0-9.]+)'));
          return numberMatch ? numberMatch[1] : undefined;
        };
        if (!parsed) {
          const rows = [
            ["status", fallbackValue("status")],
            ["classification", fallbackValue("classification")],
            ["exit", fallbackValue("exitCode")],
            ["duration", fallbackValue("durationMs") ? fallbackValue("durationMs") + "ms" : undefined]
          ].filter((row) => row[1]);
          return rows.length
            ? rows.map(([label, value]) => '<div><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value) + '</span></div>').join("")
            : '<div><span>Validation</span><span>excerpt available</span></div>';
        }
        const rows = [
          ["status", parsed.status],
          ["classification", parsed.classification],
          ["exit", parsed.exitCode],
          ["duration", typeof parsed.durationMs === "number" ? Math.round(parsed.durationMs) + "ms" : undefined],
          ["observed", Array.isArray(parsed.observedMethods) ? parsed.observedMethods.join(", ") : undefined],
          ["recording", typeof parsed.recordingDurationMs === "number" ? Math.round(parsed.recordingDurationMs / 100) / 10 + "s" : undefined]
        ].filter((row) => row[1] !== undefined && row[1] !== null && String(row[1]).length > 0);
        return rows.map(([label, value]) => '<div><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value) + '</span></div>').join("");
      }
      function renderJourneys() {
        const cells = currentCells();
        return '<section class="panel"><div class="panel-head"><h2>Journey Health</h2><span class="muted">Actionable stage coverage across every surface</span></div><div class="stage-board">' +
          stages.map((stage) => {
            const stageCells = cells.filter((cell) => cell.stage === stage.id);
            const executed = stageCells.filter((cell) => cell.status !== "proof-gap");
            const first = executed[0] || stageCells[0];
            const proofBadges = executed.flatMap(mediaListForCell);
            return '<button class="stage-row" data-key="' + escapeHtml((first?.surface || 'web-ui') + ':' + stage.id) + '" data-open-view="matrix">' +
              '<div><div>' + statusPill(statusClassForStage(stageCells)) + '</div><h3>' + escapeHtml(stage.label) + '</h3><div class="muted">' + escapeHtml(stage.id) + '</div></div>' +
              '<div><div class="status-strip">' + surfaces.map((surface) => {
                const cell = stageCells.find((candidate) => candidate.surface === surface.id);
                return '<span class="status-block ' + escapeHtml(cell?.status || "proof-gap") + '" title="' + escapeHtml(surface.label + ': ' + (cell?.status || "proof-gap")) + '">' + escapeHtml(surface.label.slice(0, 3)) + '</span>';
              }).join("") + '</div><div class="muted">' + executed.length + ' proven · ' + (stageCells.length - executed.length) + ' gaps</div></div>' +
              '<div><strong>' + escapeHtml(proofBadges.length ? Array.from(new Set(proofBadges)).join(" + ") : "No proof yet") + '</strong><div class="muted">media, logs, and validation attached per cell</div></div>' +
              '<div><span class="pill">' + escapeHtml(nextActionForStage(stageCells)) + '</span></div>' +
              '</button>';
          }).join("") + '</div></section>';
      }
      function renderValidationWorkbench() {
        const run = currentRun();
        const analysis = runAnalysis();
        const validationCells = analysis.executed.filter((cell) => cell.proof?.machineValidation);
        const logCells = analysis.executed.filter((cell) => cell.proof?.logs?.length);
        const mediaCells = analysis.executed.filter((cell) => cell.proof?.screenshot || cell.proof?.gif || cell.proof?.recording);
        return '<section class="panel"><div class="panel-head"><h2>Validation Workbench</h2><span class="muted">Machine checks tied to visual proof</span></div>' +
          '<div class="workbench-grid">' +
          '<div class="insight-card"><h3>Evidence Readiness</h3><div class="score-grid">' +
          renderScoreCard("Executable proof", analysis.executed.length + " cells", analysis.proofCoverage + "% matrix coverage", analysis.proofCoverage, "blue") +
          renderScoreCard("Validated proof", validationCells.length + " cells", analysis.validationCoverage + "% executed coverage", analysis.validationCoverage) +
          renderScoreCard("Visual proof", mediaCells.length + " cells", "screenshots, GIFs, or videos", pct(mediaCells.length, analysis.executed.length), "amber") +
          renderScoreCard("Log proof", logCells.length + " cells", analysis.inventory.logs + " log artifacts", pct(logCells.length, analysis.executed.length), "blue") +
          '</div><div class="stage-board">' + analysis.executed.map((cell) =>
            '<button class="stage-row" data-key="' + escapeHtml(cell.surface + ':' + cell.stage) + '">' +
            '<div>' + statusPill(cell.status) + '<h3>' + escapeHtml(surfaceLabel(cell.surface)) + '</h3><div class="muted">' + escapeHtml(stageLabel(cell.stage)) + '</div></div>' +
            '<div><strong>' + escapeHtml(mediaListForCell(cell).join(" + ") || "log") + '</strong><div class="muted">' + escapeHtml(cell.reason) + '</div></div>' +
            '<div class="path-text muted">' + escapeHtml((cell.proof?.machineValidation || cell.proof?.logs?.[0] || "no artifact").replaceAll("/", " / ")) + '</div>' +
            '<div><span class="pill">' + escapeHtml(Math.round((cell.durationMs || 0) / 100) / 10 + "s") + '</span></div>' +
            '</button>'
          ).join("") + '</div></div>' +
          '<div class="insight-card"><h3>Run Package</h3><div class="kv">' +
          '<div class="kv-row"><span>Run ID</span><span>' + escapeHtml(run.runId || "none") + '</span></div>' +
          '<div class="kv-row"><span>Status</span><span>' + escapeHtml(run.status || "idle") + '</span></div>' +
          '<div class="kv-row"><span>Branch</span><span>' + escapeHtml(run.branch || "unknown") + '</span></div>' +
          '<div class="kv-row"><span>SHA</span><span>' + escapeHtml((run.gitSha || "").slice(0, 12) || "unknown") + '</span></div>' +
          '<div class="kv-row"><span>Artifact root</span><span class="path-text">' + escapeHtml(sanitizeUiText(run.artifactRoot || "none")) + '</span></div>' +
          '</div><h3>Attached Files</h3><div class="proof-inventory">' +
          renderCountCard("Screenshots", analysis.inventory.screenshots) +
          renderCountCard("GIFs", analysis.inventory.gifs) +
          renderCountCard("Videos", analysis.inventory.videos) +
          renderCountCard("Validation", analysis.inventory.validations) +
          '</div><h3>Latest Validation</h3><div class="validation-summary" data-validation-summary-rel="' + escapeHtml(validationCells[0]?.proof?.machineValidation || "") + '">Loading validation summary...</div></div>' +
          '</div></section>';
      }
      function renderEvidenceGallery() {
        const run = currentRun();
        const cells = executedCells();
        return '<section class="panel"><div class="panel-head"><h2>Evidence Gallery</h2><span class="muted">' + cells.length + ' captured proof cells</span></div>' +
          '<div class="evidence-grid">' + cells.map((cell) => renderEvidenceCard(run, cell)).join("") + '</div></section>';
      }
      function renderEvidenceCard(run, cell) {
        const proof = cell.proof || {};
        const media = renderProofMedia(run, cell, true);
        const summary = proof.machineValidation ? '<div class="validation-summary" data-validation-summary-rel="' + escapeHtml(proof.machineValidation) + '">Loading validation summary...</div>' : '';
        const logOnly = Boolean(proof.logs?.[0] && !proof.screenshot && !proof.gif);
        return '<button class="evidence-card ' + (cell.surface + ':' + cell.stage === selectedKey ? 'selected' : '') + '" data-key="' + cell.surface + ':' + cell.stage + '">' +
          (logOnly ? '' : media) +
          '<div>' + statusPill(cell.status) + '</div><h3>' + escapeHtml(cell.surface + ' / ' + cell.stage) + '</h3>' +
          '<div class="muted">' + escapeHtml(cell.reason) + '</div>' +
          '<div class="kv"><div class="kv-row"><span>Duration</span><span>' + Math.round((cell.durationMs || 0) / 100) / 10 + 's</span></div><div class="kv-row"><span>Automation</span><span>' + escapeHtml(cell.automation) + '</span></div></div>' +
          '<div class="link-list">' + proofLinks(run, proof) + '</div>' +
          summary +
          (logOnly ? media : '') +
          '</button>';
      }
      async function hydrateEvidenceCards() {
        const run = currentRun();
        for (const node of document.querySelectorAll("[data-log-rel]")) {
          node.textContent = await loadArtifactText(run, node.dataset.logRel, 700) || "No log artifact.";
        }
        for (const node of document.querySelectorAll("[data-validation-summary-rel]")) {
          const text = await loadArtifactText(run, node.dataset.validationSummaryRel, 1600);
          node.innerHTML = text ? validationSummaryHtml(text) : "No validation artifact.";
        }
      }
      function renderDevices() {
        const cells = currentCells();
        return '<section class="panel"><div class="panel-head"><h2>Surface Lanes</h2><span class="muted">What can run now versus what needs heavier orchestration</span></div><div class="split-grid">' +
          surfaces.map((surface) => {
            const surfaceCells = cells.filter((cell) => cell.surface === surface.id);
            const executed = surfaceCells.filter((cell) => cell.status !== "proof-gap");
            const first = executed[0] || surfaceCells[0];
            const inventory = proofInventory(surfaceCells);
            const launchMode = surface.readiness === "now-local"
              ? "Safe local lane"
              : surface.readiness === "later-heavy"
                ? "Dedicated heavy lane"
                : "Manual/live lane";
            return '<button class="device-card" data-key="' + escapeHtml((first?.surface || surface.id) + ':' + (first?.stage || stages[0].id)) + '" data-open-view="matrix">' +
              '<div class="lane-head"><div><h3>' + escapeHtml(surface.label) + '</h3><div class="muted">' + escapeHtml(launchMode) + '</div></div>' + statusPill(executed.length ? statusClassForStage(surfaceCells) : "proof-gap") + '</div>' +
              '<div class="lane-meter">' + surfaceCells.map((cell) => '<span class="lane-dot ' + escapeHtml(cell.status) + '" title="' + escapeHtml(stageLabel(cell.stage) + ': ' + cell.status) + '"></span>').join("") + '</div>' +
              '<div class="kv"><div class="kv-row"><span>Proven cells</span><span>' + executed.length + ' / ' + surfaceCells.length + '</span></div>' +
              '<div class="kv-row"><span>Media</span><span>' + inventory.mediaCells + ' cell(s)</span></div>' +
              '<div class="kv-row"><span>Logs</span><span>' + inventory.logs + '</span></div>' +
              '<div class="kv-row"><span>Next</span><span>' + escapeHtml(nextActionForStage(surfaceCells)) + '</span></div></div>' +
              '</button>';
          }).join("") + '</div></section>';
      }
      function renderReports() {
        const run = currentRun();
        return '<section class="panel"><div class="panel-head"><h2>Release History</h2><span class="muted">Runs grouped by branch/SHA until release notes are wired</span></div>' +
          renderReleaseLedger({ compact: false }) +
          '</section>' +
          '<section class="panel"><div class="panel-head"><h2>Artifacts</h2><span class="muted">Selected run files</span></div>' +
          '<div class="report-grid">' +
          '<div class="report-card"><h3>Artifact root</h3><div class="path-text">' + escapeHtml(sanitizeUiText(run.artifactRoot || 'none')) + '</div></div>' +
          '<div class="report-card"><h3>qa-evidence.json</h3><pre id="qa-evidence-report">Loading...</pre></div>' +
          '<div class="report-card"><h3>release-ledger.json</h3><pre id="release-ledger-report">Loading...</pre></div>' +
          '<div class="report-card"><h3>scorecard.md</h3><pre id="scorecard-report">Loading...</pre></div>' +
          '<div class="report-card"><h3>commands.txt</h3><pre id="commands-report">Loading...</pre></div>' +
          '</div></section>';
      }
      async function hydrateReports() {
        const run = currentRun();
        const qaEvidence = await loadArtifactText(run, "qa-evidence.json", 5000);
        const releaseLedger = await loadArtifactText(run, "release-ledger.json", 5000);
        const scorecard = await loadArtifactText(run, "scorecard.md", 5000);
        const commands = await loadArtifactText(run, "commands.txt", 5000);
        const qaEvidenceNode = document.getElementById("qa-evidence-report");
        const releaseLedgerNode = document.getElementById("release-ledger-report");
        const scorecardNode = document.getElementById("scorecard-report");
        const commandsNode = document.getElementById("commands-report");
        if (qaEvidenceNode) qaEvidenceNode.textContent = qaEvidence || "No QA evidence artifact for this run.";
        if (releaseLedgerNode) releaseLedgerNode.textContent = releaseLedger || "No release ledger artifact for this run.";
        if (scorecardNode) scorecardNode.textContent = scorecard || "No scorecard artifact.";
        if (commandsNode) commandsNode.textContent = commands || "No commands artifact.";
      }
      async function loadArtifactText(run, rel, limit) {
        if (!run?.runId || !rel) return "";
        try {
          const text = await fetch(artifactUrl(run.runId, rel)).then((res) => res.text());
          return sanitizeUiText(text).slice(0, limit);
        } catch {
          return "";
        }
      }
      async function renderInspector() {
        const run = currentRun();
        const matrix = currentMatrix();
        const cells = matrix?.cells || [];
        const cell = cells.find((candidate) => candidate.surface + ":" + candidate.stage === selectedKey) || cells.find((candidate) => candidate.proof?.screenshot || candidate.proof?.recording) || cells[0];
        const inspector = document.getElementById("inspector");
        if (!cell) {
          inspector.innerHTML = '<div class="muted">No evidence selected.</div>';
          return;
        }
        selectedKey = cell.surface + ":" + cell.stage;
        document.getElementById("selected-label").textContent = cell.surface + " / " + cell.stage;
        const proof = cell.proof || {};
        const media = [
          proof.screenshot && '<img alt="' + escapeHtml(cell.surface + ' ' + cell.stage + ' screenshot') + '" src="' + artifactUrl(run.runId, proof.screenshot) + '" />',
          proof.gif && '<img alt="' + escapeHtml(cell.surface + ' ' + cell.stage + ' gif') + '" src="' + artifactUrl(run.runId, proof.gif) + '" />'
        ].filter(Boolean).join("");
        const links = [
          proof.screenshot && ["screenshot", proof.screenshot],
          proof.gif && ["gif", proof.gif],
          proof.recording && ["video", proof.recording],
          proof.machineValidation && ["validation", proof.machineValidation],
          ...(proof.logs || []).map((log) => ["log", log])
        ].filter(Boolean).map(([label, rel]) => '<a href="' + artifactUrl(run.runId, rel) + '" target="_blank">' + escapeHtml(label) + '</a>').join("");
        inspector.innerHTML = '<div><span class="status ' + cell.status + '">' + cell.status + '</span></div>' +
          '<div class="detail-title"><strong>' + escapeHtml(cell.stage) + '</strong><div class="muted">' + escapeHtml(cell.surface) + ' · ' + Math.round((cell.durationMs || 0) / 100) / 10 + 's</div></div>' +
          '<div>' + escapeHtml(cell.reason || "") + '</div>' +
          '<div class="link-list">' + links + '</div>' +
          (proof.recordingDurationMs ? '<div class="pill">recording ' + Math.round(proof.recordingDurationMs / 1000) + 's</div>' : '') +
          '<div class="artifact-media">' + (media || '<div class="muted">No media for this cell.</div>') + '</div>' +
          '<div><h3>Validation summary</h3><div class="validation-summary" id="validation-summary">Loading...</div></div>' +
          '<div><h3>Raw validation excerpt</h3><pre class="raw-excerpt" id="validation-snippet">Loading...</pre></div>' +
          '<div><h3>Log excerpt</h3><pre class="raw-excerpt" id="log-snippet">Loading...</pre></div>';
        const validation = await loadArtifactText(run, proof.machineValidation, 2200);
        const log = await loadArtifactText(run, (proof.logs || [])[0], 2200);
        const validationSummaryNode = document.getElementById("validation-summary");
        const validationNode = document.getElementById("validation-snippet");
        const logNode = document.getElementById("log-snippet");
        if (validationSummaryNode) validationSummaryNode.innerHTML = validation ? validationSummaryHtml(validation) : "No validation artifact.";
        if (validationNode) validationNode.textContent = validation || "No validation artifact.";
        if (logNode) logNode.textContent = log || "No log artifact.";
      }
      runButton.addEventListener("click", async () => {
        runButton.disabled = true;
        selectedRunId = null;
        selectedView = "runs";
        await fetch("/api/runs", { method: "POST" });
        refresh();
      });
      document.querySelectorAll(".nav button[data-view]").forEach((node) => node.addEventListener("click", () => {
        selectedView = node.dataset.view;
        renderNav();
        renderView();
        renderInspector();
      }));
      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.artifactBase, { recursive: true });
  if (options.once) {
    const summary = await runMatrix(options);
    console.log(`[ux-matrix] run ${summary.runId} ${summary.status}`);
    console.log(`[ux-matrix] artifacts ${summary.artifactRoot}`);
    return;
  }
  const server = createServer((request, response) => {
    handleRequest(request, response, options).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, resolve);
  });
  const url = `http://${options.host}:${options.port}/`;
  console.log(`[ux-matrix] dashboard ${url}`);
  console.log(`[ux-matrix] artifacts ${options.artifactBase}`);
  if (options.runOnStart) {
    activeRun = runMatrix(options).finally(() => {
      activeRun = null;
    });
  }
}

await main();
