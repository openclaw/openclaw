// Workboard plugin module implements gateway behavior.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { WorkboardStore } from "./store.js";
import { WORKBOARD_STATUSES, type WorkboardCard } from "./types.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const CODEFARM_JOB_ID_PATTERN = /^cf_\d{8}_\d{3,}$/;
const CODEFARM_OBSERVE_DEFAULT_LINES = 200;
const CODEFARM_OBSERVE_MAX_LINES = 1000;
const CODEFARM_OBSERVE_TIMEOUT_MS = 10_000;
const CODEFARM_OBSERVE_MAX_BUFFER = 1_500_000;
const CODEFARM_DISCOVER_DEFAULT_MAX_DEPTH = 5;
const CODEFARM_DISCOVER_MAX_DEPTH = 8;
const CODEFARM_DISCOVER_MAX_REPOS = 80;
const CODEFARM_PROJECT_CONTEXT_MAX_CHARS = 8_000;
const CODEFARM_PROJECT_TERMINAL_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

export type CodefarmObserveParams = {
  repo: string;
  jobId: string;
  lines: number;
};

export type CodefarmListParams = {
  repo: string;
};

export type CodefarmProjectParams = {
  repo: string;
};

export type CodefarmProjectArchiveParams = {
  repo: string;
  archived: boolean;
};

export type CodefarmReposParams = {
  roots?: string[];
  maxDepth?: number;
  includeArchived?: boolean;
};

export type CodefarmRepoSummary = {
  repo: string;
  name: string;
  status: "active" | "archived";
  archived: boolean;
  archivedAt?: string;
  totalJobs: number;
  activeJobs: number;
  reviewJobs: number;
  blockedJobs: number;
  latestUpdatedAt?: string;
  statuses: Record<string, number>;
};

export type CodefarmObserveRunner = (params: CodefarmObserveParams) => Promise<unknown>;
export type CodefarmListRunner = (params: CodefarmListParams) => Promise<unknown>;
export type CodefarmProjectRunner = (params: CodefarmProjectParams) => Promise<unknown>;
export type CodefarmProjectArchiveRunner = (
  params: CodefarmProjectArchiveParams,
) => Promise<unknown>;
export type CodefarmReposRunner = (params: CodefarmReposParams) => Promise<unknown>;

function respondError(respond: GatewayRespond, error: unknown) {
  respond(false, undefined, {
    code: "workboard_error",
    message: formatErrorMessage(error),
  });
}

function readId(params: Record<string, unknown>): string {
  const value = params.id;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error("id is required.");
}

function readPatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch = params.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return patch as Record<string, unknown>;
  }
  return params;
}

function assertNoCursorAdvance(params: Record<string, unknown>) {
  if (params.advance === true) {
    throw new Error("notification cursor advancement requires workboard.notifications.advance.");
  }
}

function isAbsoluteRepoPath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function readCodefarmObserveLines(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return CODEFARM_OBSERVE_DEFAULT_LINES;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("lines must be a finite number.");
  }
  const lines = Math.trunc(value);
  if (lines < 0 || lines > CODEFARM_OBSERVE_MAX_LINES) {
    throw new Error(`lines must be between 0 and ${CODEFARM_OBSERVE_MAX_LINES}.`);
  }
  return lines;
}

function readCodefarmObserveParams(params: Record<string, unknown>): CodefarmObserveParams {
  const repo = typeof params.repo === "string" ? params.repo.trim() : "";
  if (!repo) {
    throw new Error("repo is required.");
  }
  if (repo.includes("\0") || !isAbsoluteRepoPath(repo)) {
    throw new Error("repo must be an absolute local path.");
  }
  const jobId = typeof params.jobId === "string" ? params.jobId.trim() : "";
  if (!CODEFARM_JOB_ID_PATTERN.test(jobId)) {
    throw new Error("jobId must look like cf_YYYYMMDD_001.");
  }
  return {
    repo,
    jobId,
    lines: readCodefarmObserveLines(params.lines),
  };
}

function readCodefarmListParams(params: Record<string, unknown>): CodefarmListParams {
  const repo = typeof params.repo === "string" ? params.repo.trim() : "";
  if (!repo) {
    throw new Error("repo is required.");
  }
  if (repo.includes("\0") || !isAbsoluteRepoPath(repo)) {
    throw new Error("repo must be an absolute local path.");
  }
  return { repo };
}

function readCodefarmProjectParams(params: Record<string, unknown>): CodefarmProjectParams {
  return readCodefarmListParams(params);
}

function readCodefarmReposParams(params: Record<string, unknown>): CodefarmReposParams {
  const roots =
    Array.isArray(params.roots) && params.roots.length > 0
      ? params.roots.map((value) => {
          const root = typeof value === "string" ? value.trim() : "";
          if (!root || root.includes("\0") || !isAbsoluteRepoPath(root)) {
            throw new Error("roots must be absolute local paths.");
          }
          return root;
        })
      : undefined;
  const rawDepth = params.maxDepth;
  const includeArchived =
    typeof params.includeArchived === "boolean" ? params.includeArchived : undefined;
  if (rawDepth === undefined || rawDepth === null || rawDepth === "") {
    return {
      ...(roots ? { roots } : {}),
      ...(includeArchived !== undefined ? { includeArchived } : {}),
    };
  }
  if (typeof rawDepth !== "number" || !Number.isFinite(rawDepth)) {
    throw new Error("maxDepth must be a finite number.");
  }
  const maxDepth = Math.trunc(rawDepth);
  if (maxDepth < 0 || maxDepth > CODEFARM_DISCOVER_MAX_DEPTH) {
    throw new Error(`maxDepth must be between 0 and ${CODEFARM_DISCOVER_MAX_DEPTH}.`);
  }
  return {
    ...(roots ? { roots } : {}),
    maxDepth,
    ...(includeArchived !== undefined ? { includeArchived } : {}),
  };
}

function parseCodefarmJsonOutput(stdout: string | Buffer, emptyMessage: string): unknown {
  const output = typeof stdout === "string" ? stdout.trim() : Buffer.from(stdout).toString().trim();
  if (!output) {
    throw new Error(emptyMessage);
  }
  return JSON.parse(output);
}

export async function listCodefarmJobsWithCli(params: CodefarmListParams): Promise<unknown> {
  const bin = process.env.OPENCLAW_CODEFARM_BIN?.trim() || "codefarm";
  const { stdout } = await execFileAsync(bin, ["list", "--repo", params.repo, "--json"], {
    timeout: CODEFARM_OBSERVE_TIMEOUT_MS,
    maxBuffer: CODEFARM_OBSERVE_MAX_BUFFER,
  });
  return parseCodefarmJsonOutput(stdout, "codefarm list returned no JSON output.");
}

export async function observeCodefarmJobWithCli(params: CodefarmObserveParams): Promise<unknown> {
  const bin = process.env.OPENCLAW_CODEFARM_BIN?.trim() || "codefarm";
  const args = [
    "observe",
    params.jobId,
    "--repo",
    params.repo,
    "--json",
    "--lines",
    String(params.lines),
  ];
  const { stdout } = await execFileAsync(bin, args, {
    timeout: CODEFARM_OBSERVE_TIMEOUT_MS,
    maxBuffer: CODEFARM_OBSERVE_MAX_BUFFER,
  });
  return parseCodefarmJsonOutput(stdout, "codefarm observe returned no JSON output.");
}

export async function archiveCodefarmProjectWithCli(
  params: CodefarmProjectArchiveParams,
): Promise<unknown> {
  const bin = process.env.OPENCLAW_CODEFARM_BIN?.trim() || "codefarm";
  const command = params.archived ? "archive" : "unarchive";
  const { stdout } = await execFileAsync(
    bin,
    ["project", command, "--repo", params.repo, "--json"],
    {
      timeout: CODEFARM_OBSERVE_TIMEOUT_MS,
      maxBuffer: CODEFARM_OBSERVE_MAX_BUFFER,
    },
  );
  return parseCodefarmJsonOutput(stdout, `codefarm project ${command} returned no JSON output.`);
}

function normalizeDiscoveryRoot(root: string): string | null {
  const trimmed = root.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return null;
  }
  const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsoluteRepoPath(expanded)) {
    return null;
  }
  return path.resolve(expanded);
}

function defaultCodefarmDiscoveryRoots(): string[] {
  const envRoots = (process.env.OPENCLAW_CODEFARM_REPO_ROOTS ?? "")
    .split(path.delimiter)
    .map(normalizeDiscoveryRoot)
    .filter((root): root is string => Boolean(root));
  const home = os.homedir();
  const defaults = [
    path.join(home, "Agent-Corporation"),
    path.join(home, "Github"),
    path.join(home, ".openclaw", "workspaces"),
  ];
  return [...new Set([...envRoots, ...defaults].map((root) => path.resolve(root)))];
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function incrementStatus(statuses: Record<string, number>, status: string) {
  statuses[status] = (statuses[status] ?? 0) + 1;
}

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

type CodefarmProjectMetadata = {
  status: "active" | "archived";
  archived: boolean;
  archivedAt?: string;
  name?: string;
};

async function readCodefarmProjectMetadata(repo: string): Promise<CodefarmProjectMetadata | null> {
  const raw = await readJsonFile(path.join(repo, ".codefarm", "project.json"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const archived = record.archived === true || record.status === "archived";
  return {
    status: archived ? "archived" : "active",
    archived,
    ...(archived && typeof record.archivedAt === "string" ? { archivedAt: record.archivedAt } : {}),
    ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
  };
}

function jobIdFromIndexEntry(entry: unknown): string | null {
  if (typeof entry === "string" && entry.trim()) {
    return entry.trim();
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }
  return null;
}

async function summarizeCodefarmRepo(repo: string): Promise<CodefarmRepoSummary | null> {
  const metadata = await readCodefarmProjectMetadata(repo);
  const index = await readJsonFile(path.join(repo, ".codefarm", "index.json"));
  if ((!index || typeof index !== "object" || Array.isArray(index)) && !metadata) {
    return null;
  }
  const jobIds =
    index &&
    typeof index === "object" &&
    !Array.isArray(index) &&
    Array.isArray((index as { jobs?: unknown }).jobs)
      ? ((index as { jobs: unknown[] }).jobs.map(jobIdFromIndexEntry).filter(Boolean) as string[])
      : [];
  if (jobIds.length === 0 && !metadata) {
    return null;
  }
  const statuses: Record<string, number> = {};
  let latestMs: number | null = null;
  for (const jobId of jobIds) {
    const job = await readJsonFile(path.join(repo, ".codefarm", "jobs", jobId, "JOB.json"));
    const record = job && typeof job === "object" && !Array.isArray(job) ? job : {};
    const status =
      typeof (record as { status?: unknown }).status === "string" &&
      (record as { status: string }).status.trim()
        ? (record as { status: string }).status.trim()
        : "unknown";
    incrementStatus(statuses, status);
    const updatedAt = parseTimestamp((record as { updatedAt?: unknown }).updatedAt);
    if (updatedAt !== null && (latestMs === null || updatedAt > latestMs)) {
      latestMs = updatedAt;
    }
  }
  return {
    repo,
    name: metadata?.name ?? path.basename(repo) ?? repo,
    status: metadata?.status ?? "active",
    archived: metadata?.archived ?? false,
    ...(metadata?.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
    totalJobs: jobIds.length,
    activeJobs: (statuses.running ?? 0) + (statuses.preparing ?? 0),
    reviewJobs: statuses.ready_for_review ?? 0,
    blockedJobs: (statuses.blocked ?? 0) + (statuses.needs_recovery ?? 0) + (statuses.failed ?? 0),
    ...(latestMs !== null ? { latestUpdatedAt: new Date(latestMs).toISOString() } : {}),
    statuses,
  };
}

type CodefarmProjectFileKind = "agent_context" | "project_doc" | "gsd_project" | "gsd_state";

type CodefarmProjectFile = {
  path: string;
  title: string;
  kind: CodefarmProjectFileKind;
  content: string;
  truncated: boolean;
};

const CODEFARM_PROJECT_CONTEXT_FILES: Array<{ path: string; kind: CodefarmProjectFileKind }> = [
  { path: "AGENTS.md", kind: "agent_context" },
  { path: "CLAUDE.md", kind: "agent_context" },
  { path: "GEMINI.md", kind: "agent_context" },
  { path: "README.md", kind: "project_doc" },
  { path: "docs/PROJECT.md", kind: "project_doc" },
  { path: "docs/project.md", kind: "project_doc" },
  { path: ".codefarm/PROJECT.md", kind: "project_doc" },
];

const CODEFARM_GSD_FILES: Array<{ path: string; kind: CodefarmProjectFileKind }> = [
  { path: ".gsd/PROJECT.md", kind: "gsd_project" },
  { path: ".gsd/REQUIREMENTS.md", kind: "gsd_project" },
  { path: ".gsd/STATE.md", kind: "gsd_state" },
  { path: ".gsd/KNOWLEDGE.md", kind: "gsd_project" },
  { path: ".gsd/DECISIONS.md", kind: "gsd_project" },
];

async function readProjectFile(
  repo: string,
  candidate: { path: string; kind: CodefarmProjectFileKind },
): Promise<CodefarmProjectFile | null> {
  const repoRoot = path.resolve(repo);
  const file = path.resolve(repoRoot, candidate.path);
  if (file !== repoRoot && !file.startsWith(`${repoRoot}${path.sep}`)) {
    return null;
  }
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return {
    path: candidate.path,
    title: path.basename(candidate.path),
    kind: candidate.kind,
    content: content.slice(0, CODEFARM_PROJECT_CONTEXT_MAX_CHARS),
    truncated: content.length > CODEFARM_PROJECT_CONTEXT_MAX_CHARS,
  };
}

async function readProjectFiles(
  repo: string,
  candidates: Array<{ path: string; kind: CodefarmProjectFileKind }>,
): Promise<CodefarmProjectFile[]> {
  const files = await Promise.all(candidates.map((candidate) => readProjectFile(repo, candidate)));
  return files.filter((file): file is CodefarmProjectFile => Boolean(file));
}

function slugForTmux(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

function codefarmProjectSessionName(repo: string): string {
  const resolved = path.resolve(repo);
  const basename = slugForTmux(path.basename(resolved));
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `codefarm_${basename}-${digest}`;
}

async function readProjectTerminal(repo: string): Promise<{
  session: string;
  attachCommand: string;
  running: boolean;
  persistent: boolean;
  note?: string;
}> {
  const session = codefarmProjectSessionName(repo);
  try {
    await execFileAsync("tmux", ["has-session", "-t", session], {
      timeout: CODEFARM_PROJECT_TERMINAL_TIMEOUT_MS,
    });
    return {
      session,
      attachCommand: `tmux attach -t ${session}`,
      running: true,
      persistent: true,
    };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    return {
      session,
      attachCommand: `tmux attach -t ${session}`,
      running: false,
      persistent: true,
      note:
        code === "ENOENT"
          ? "tmux is not installed."
          : "No persistent project tmux session is running.",
    };
  }
}

export async function readCodefarmProject(params: CodefarmProjectParams): Promise<{
  schemaVersion: 1;
  repo: string;
  name: string;
  status: "active" | "archived";
  archived: boolean;
  archivedAt?: string;
  jobs: {
    totalJobs: number;
    activeJobs: number;
    reviewJobs: number;
    blockedJobs: number;
    latestUpdatedAt?: string;
    statuses: Record<string, number>;
  };
  contextFiles: CodefarmProjectFile[];
  gsd: {
    available: boolean;
    files: CodefarmProjectFile[];
  };
  projectTerminal: Awaited<ReturnType<typeof readProjectTerminal>>;
}> {
  const repo = path.resolve(params.repo);
  const [summary, contextFiles, gsdFiles, projectTerminal] = await Promise.all([
    summarizeCodefarmRepo(repo),
    readProjectFiles(repo, CODEFARM_PROJECT_CONTEXT_FILES),
    readProjectFiles(repo, CODEFARM_GSD_FILES),
    readProjectTerminal(repo),
  ]);
  return {
    schemaVersion: 1,
    repo,
    name: summary?.name ?? path.basename(repo) ?? repo,
    status: summary?.status ?? "active",
    archived: summary?.archived ?? false,
    ...(summary?.archivedAt ? { archivedAt: summary.archivedAt } : {}),
    jobs: {
      totalJobs: summary?.totalJobs ?? 0,
      activeJobs: summary?.activeJobs ?? 0,
      reviewJobs: summary?.reviewJobs ?? 0,
      blockedJobs: summary?.blockedJobs ?? 0,
      ...(summary?.latestUpdatedAt ? { latestUpdatedAt: summary.latestUpdatedAt } : {}),
      statuses: summary?.statuses ?? {},
    },
    contextFiles,
    gsd: {
      available: gsdFiles.length > 0,
      files: gsdFiles,
    },
    projectTerminal,
  };
}

function shouldSkipDiscoveryDir(name: string): boolean {
  return new Set([
    ".codefarm",
    ".git",
    ".hg",
    ".svn",
    ".worktrees",
    "node_modules",
    "Library",
    "Applications",
    "dist",
    "build",
  ]).has(name);
}

async function pathIsDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function discoverCodefarmReposFromRoots(params: CodefarmReposParams = {}): Promise<{
  schemaVersion: 1;
  repos: CodefarmRepoSummary[];
  scannedRoots: string[];
}> {
  const roots = (params.roots?.length ? params.roots : defaultCodefarmDiscoveryRoots())
    .map(normalizeDiscoveryRoot)
    .filter((root): root is string => Boolean(root));
  const scannedRoots = [...new Set(roots)].map((root) => path.resolve(root));
  const maxDepth = Math.min(
    CODEFARM_DISCOVER_MAX_DEPTH,
    Math.max(0, Math.trunc(params.maxDepth ?? CODEFARM_DISCOVER_DEFAULT_MAX_DEPTH)),
  );
  const repos = new Map<string, CodefarmRepoSummary>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (repos.size >= CODEFARM_DISCOVER_MAX_REPOS || !(await pathIsDirectory(dir))) {
      return;
    }
    const summary = await summarizeCodefarmRepo(dir);
    if (summary && (params.includeArchived || !summary.archived)) {
      repos.set(summary.repo, summary);
      return;
    }
    if (depth <= 0) {
      return;
    }
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Array<{
        name: string;
        isDirectory: () => boolean;
      }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDiscoveryDir(entry.name)) {
        continue;
      }
      await walk(path.join(dir, entry.name), depth - 1);
      if (repos.size >= CODEFARM_DISCOVER_MAX_REPOS) {
        return;
      }
    }
  }

  for (const root of scannedRoots) {
    await walk(root, maxDepth);
  }

  return {
    schemaVersion: 1,
    scannedRoots,
    repos: [...repos.values()].sort((left, right) => {
      if (right.activeJobs !== left.activeJobs) {
        return right.activeJobs - left.activeJobs;
      }
      return (
        (parseTimestamp(right.latestUpdatedAt) ?? 0) - (parseTimestamp(left.latestUpdatedAt) ?? 0)
      );
    }),
  };
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: { ...claim, token: "[redacted]" },
    },
  };
}

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactClaimToken(row.card),
    })),
  };
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
  discoverCodefarm?: CodefarmReposRunner;
  projectCodefarm?: CodefarmProjectRunner;
  listCodefarm?: CodefarmListRunner;
  observeCodefarm?: CodefarmObserveRunner;
  archiveCodefarm?: CodefarmProjectArchiveRunner;
}) {
  const { api } = params;
  const store = params.store ?? WorkboardStore.openSqlite();
  const discoverCodefarm = params.discoverCodefarm ?? discoverCodefarmReposFromRoots;
  const projectCodefarm = params.projectCodefarm ?? readCodefarmProject;
  const listCodefarm = params.listCodefarm ?? listCodefarmJobsWithCli;
  const observeCodefarm = params.observeCodefarm ?? observeCodefarmJobWithCli;
  const archiveCodefarm = params.archiveCodefarm ?? archiveCodefarmProjectWithCli;

  api.registerGatewayMethod(
    "workboard.cards.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          cards: (await store.list({ boardId: requestParams.boardId })).map(redactClaimToken),
          statuses: WORKBOARD_STATUSES,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.create",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { card: redactClaimToken(await store.create(requestParams)) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.update",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.update(readId(requestParams), readPatch(requestParams)),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.move",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.move(readId(requestParams), requestParams.status, requestParams.position),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.delete(readId(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.comment",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addComment(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.link",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addLink(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.linkDependency",
    async ({ params: requestParams, respond }) => {
      try {
        const parentId = requestParams.parentId;
        const childId = requestParams.childId;
        if (typeof parentId !== "string" || typeof childId !== "string") {
          throw new Error("parentId and childId are required.");
        }
        respond(true, {
          card: redactClaimToken(await store.linkCards(parentId, childId)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.proof",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addProof(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.artifact",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addArtifact(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.claim",
    async ({ params: requestParams, respond }) => {
      try {
        const claimed = await store.claim(readId(requestParams), requestParams);
        respond(true, { ...claimed, card: redactClaimToken(claimed.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.heartbeat",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.heartbeat(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.release",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.releaseClaim(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.promote",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.promote(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.reassign",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.reassign(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.reclaim",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.reclaim(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.complete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.complete(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.block",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.block(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.unblock",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.unblock(readId(requestParams))),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.bulk",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.bulkUpdate(requestParams);
        respond(true, { cards: result.cards.map(redactClaimToken) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.diagnostics",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await store.diagnostics()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.diagnostics.refresh",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await store.refreshDiagnostics()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.dispatch",
    async ({ params: requestParams, respond }) => {
      try {
        const boardId =
          requestParams && typeof requestParams === "object" && "boardId" in requestParams
            ? requestParams.boardId
            : undefined;
        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: api.runtime.subagent,
          options: {
            boardId: typeof boardId === "string" ? boardId : undefined,
          },
        });
        respond(true, {
          ...result,
          promoted: result.promoted.map(redactClaimToken),
          reclaimed: result.reclaimed.map(redactClaimToken),
          blocked: result.blocked.map(redactClaimToken),
          orchestrated: result.orchestrated.map(redactClaimToken),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.list",
    async ({ respond }) => {
      try {
        respond(true, await store.listBoards());
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.upsert",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { board: await store.upsertBoard(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.archive",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          board: await store.archiveBoard(requestParams.id, requestParams.archived),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.deleteBoard(requestParams.id));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.stats",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.stats({ boardId: requestParams.boardId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.runs",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.runs(readId(requestParams));
        respond(true, { ...result, card: redactClaimToken(result.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.specify",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.specify(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.decompose",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.decompose(readId(requestParams), requestParams, null);
        respond(true, {
          parent: redactClaimToken(result.parent),
          children: result.children.map(redactClaimToken),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.subscribe",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { subscription: await store.subscribeNotifications(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.listNotificationSubscriptions(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.deleteNotificationSubscription(readId(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.events",
    async ({ params: requestParams, respond }) => {
      try {
        assertNoCursorAdvance(requestParams);
        respond(true, await store.notificationEvents(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.advance",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.advanceNotificationEvents(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.list",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.listAttachments(readId(requestParams));
        respond(true, { ...result, card: redactClaimToken(result.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.get",
    async ({ params: requestParams, respond }) => {
      try {
        const attachment = await store.getAttachment(readId(requestParams));
        if (!attachment) {
          throw new Error(`attachment not found: ${readId(requestParams)}`);
        }
        respond(true, attachment);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.add",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addAttachment(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.delete",
    async ({ params: requestParams, respond }) => {
      try {
        const attachmentId = requestParams.attachmentId;
        if (typeof attachmentId !== "string" || !attachmentId.trim()) {
          throw new Error("attachmentId is required.");
        }
        respond(true, {
          card: redactClaimToken(
            await store.deleteAttachment(readId(requestParams), attachmentId.trim()),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.workerLog",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addWorkerLog(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.protocolViolation",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.recordProtocolViolation(readId(requestParams), requestParams),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.archive",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.archive(readId(requestParams), requestParams.archived),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.export",
    async ({ respond }) => {
      try {
        const exported = await store.exportCards();
        respond(true, { ...exported, cards: exported.cards.map(redactClaimToken) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "codefarm.repos",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await discoverCodefarm(readCodefarmReposParams(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "codefarm.project",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await projectCodefarm(readCodefarmProjectParams(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "codefarm.project.archive",
    async ({ params: requestParams, respond }) => {
      try {
        const projectParams = readCodefarmProjectParams(requestParams);
        await archiveCodefarm({ ...projectParams, archived: true });
        respond(true, await projectCodefarm(projectParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "codefarm.project.unarchive",
    async ({ params: requestParams, respond }) => {
      try {
        const projectParams = readCodefarmProjectParams(requestParams);
        await archiveCodefarm({ ...projectParams, archived: false });
        respond(true, await projectCodefarm(projectParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "codefarm.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await listCodefarm(readCodefarmListParams(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "codefarm.observe",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await observeCodefarm(readCodefarmObserveParams(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.codefarm.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await listCodefarm(readCodefarmListParams(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.codefarm.observe",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await observeCodefarm(readCodefarmObserveParams(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );
}
