import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isRecord } from "./record-shared.mjs";

export const RELEASE_PHASES = [
  "cut",
  "validate",
  "publish",
  "sync-beta",
  "flip-github",
  "macos",
  "closeout",
] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];
const phaseSchema = z.enum(RELEASE_PHASES);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const id = z.string().regex(/^[1-9][0-9]*$/u);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const phaseState = z.strictObject({
  status: z.enum(["pending", "running", "completed", "refused"]),
  startedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  error: z.string().optional(),
});
const releaseStateSchema = z.strictObject({
  version: z.literal(1),
  release: z.string().regex(/^\d{4}\.\d{1,2}\.\d+$/u),
  tag: z.string(),
  branch: z.string(),
  repo: z.string(),
  releasesRepo: z.string(),
  startedAt: timestamp,
  operator: z.strictObject({
    name: z.string(),
    login: z.string().min(1).optional(),
    cutShaConfirmed: sha.nullable(),
    publicationApproved: timestamp.nullable(),
  }),
  capabilities: z
    .strictObject({
      parentSyncsBetaDistTag: z.boolean(),
      parentSweepsStaleChildren: z.boolean().optional(),
      childNpmPublishEnvironment: z.boolean().optional(),
      probedAt: timestamp,
      toolingSha: sha,
    })
    .optional(),
  phases: z.strictObject({
    cut: phaseState,
    validate: phaseState,
    publish: phaseState,
    "sync-beta": phaseState,
    "flip-github": phaseState,
    macos: phaseState,
    closeout: phaseState,
  }),
  cut: z.strictObject({ cutSha: sha.optional(), releaseSha: sha.optional() }),
  validate: z.strictObject({
    toolingSha: sha.optional(),
    toolingTag: z.string().optional(),
    requestFile: z.string().optional(),
    runId: id.optional(),
    runAttempt: z.number().int().positive().optional(),
  }),
  publish: z.strictObject({
    candidateDir: z.string().optional(),
    publishRunId: id.optional(),
    dispatchedAt: timestamp.optional(),
    approvedGates: z.array(z.string()),
    npmVisibleAt: timestamp.optional(),
    macosValidateRunId: id.optional(),
    macosPreflightRunId: id.optional(),
  }),
  syncBeta: z.strictObject({ runId: id.optional(), verifiedAt: timestamp.optional() }),
  flipGithub: z.strictObject({
    flippedBy: z.enum(["parent", "orchestrator"]).optional(),
    verifiedAt: timestamp.optional(),
  }),
  macos: z.strictObject({
    validateRunId: id.optional(),
    preflightRunId: id.optional(),
    publishRunId: id.optional(),
    appcastVerifiedAt: timestamp.optional(),
  }),
  closeout: z.strictObject({
    publishRunConclusion: z.string().optional(),
    runId: id.optional(),
    verifiedAt: timestamp.optional(),
  }),
  history: z.array(
    z.strictObject({ at: timestamp, phase: phaseSchema, event: z.string(), detail: z.string() }),
  ),
});
// Older writers recorded retry and tooling-capability metadata even for waiver-free
// releases. Discard only that bookkeeping; actual waiver fields still fail parsing.
const releaseStateReadSchema = releaseStateSchema.extend({
  capabilities: releaseStateSchema.shape.capabilities
    .unwrap()
    .extend({
      closeoutResolvesWaivers: z.boolean().optional(),
      parentApprovalReceipt: z.boolean().optional(),
    })
    .transform(
      ({
        closeoutResolvesWaivers: _closeoutResolvesWaivers,
        parentApprovalReceipt: _parentApprovalReceipt,
        ...capabilities
      }) => capabilities,
    )
    .optional(),
  validate: releaseStateSchema.shape.validate
    .extend({ continues: z.number().int().min(0).optional() })
    .transform(({ continues: _continues, ...validation }) => validation),
});
export type ReleaseState = z.infer<typeof releaseStateSchema>;
export type ReleaseOptions = {
  release: string;
  repo: string;
  releasesRepo: string;
  stateDir: string;
  operator: string;
  from?: ReleasePhase;
  dryRun: boolean;
  status: boolean;
  approvePublication: boolean;
  cutSha?: string;
  confirmCutSha?: string;
  toolingSha?: string;
  pluginSdkApiAcknowledgement?: string;
  macosPreflightRunId?: string;
  macosValidateRunId?: string;
};
export class ReleaseRefusal extends Error {
  next: string[];
  constructor(message: string, next: string[]) {
    super(message);
    this.name = "ReleaseRefusal";
    this.next = next;
  }
}
export function acquireReleaseLock(stateDir: string): () => void {
  const path = join(stateDir, "state.lock");
  const next = [`# wait for it or remove ${path} if that pid is gone`];
  const contents = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  mkdirSync(stateDir, { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    let previous: string;
    try {
      previous = readFileSync(path, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    let lock: unknown;
    try {
      lock = JSON.parse(previous);
    } catch {
      throw new ReleaseRefusal(`Cannot read release lock ${path}; inspect its owner.`, next);
    }
    if (
      !isRecord(lock) ||
      typeof lock.pid !== "number" ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid <= 0
    ) {
      throw new ReleaseRefusal(`Invalid process ID in release lock ${path}.`, next);
    }
    let alive = true;
    try {
      process.kill(lock.pid, 0);
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") {
        alive = false;
      } else if (!isRecord(error) || error.code !== "EPERM") {
        throw error;
      }
    }
    if (alive) {
      throw new ReleaseRefusal(
        `Another release:stable process (pid ${lock.pid}) owns ${stateDir}`,
        next,
      );
    }
    try {
      if (readFileSync(path, "utf8") === previous) {
        rmSync(path);
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    continue;
  }
  if (!acquired) {
    throw new ReleaseRefusal(`Could not acquire release lock ${path} after three attempts.`, next);
  }
  const release = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rmSync(path, { force: true });
  };
  const onSignal = (signal: NodeJS.Signals) => {
    try {
      release();
    } finally {
      process.kill(process.pid, signal);
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return release;
}
export function isReleasePhase(value: string): value is ReleasePhase {
  return phaseSchema.safeParse(value).success;
}
export function shellCommand(bin: string, args: string[]): string {
  const quote = (value: string) =>
    /^[a-zA-Z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  return [bin, ...args].map(quote).join(" ");
}
export function resumeCommand(
  options: ReleaseOptions,
  phase?: ReleasePhase,
  extra: string[] = [],
): string {
  const args = ["release:stable", options.release];
  if (phase) {
    args.push("--from", phase);
  }
  const retained: [string, string | undefined][] = [
    ["repo", options.repo !== "openclaw/openclaw" ? options.repo : undefined],
    [
      "releases-repo",
      options.releasesRepo !== "openclaw/releases" ? options.releasesRepo : undefined,
    ],
    ["state-dir", options.stateDir],
    ["operator", options.operator],
    ["cut-sha", options.cutSha],
    ["confirm-cut-sha", options.confirmCutSha],
    ["tooling-sha", options.toolingSha],
    ["plugin-sdk-api-acknowledgement", options.pluginSdkApiAcknowledgement],
    ["macos-preflight-run-id", phase === "macos" ? options.macosPreflightRunId : undefined],
    ["macos-validate-run-id", phase === "macos" ? options.macosValidateRunId : undefined],
  ];
  for (const [name, value] of retained) {
    if (value !== undefined && !extra.includes(`--${name}`)) {
      args.push(`--${name}`, value);
    }
  }
  for (const [name, enabled] of [
    ["approve-publication", options.approvePublication],
    ["dry-run", options.dryRun],
    ["status", options.status],
  ] as const) {
    if (enabled && !extra.includes(`--${name}`)) {
      args.push(`--${name}`);
    }
  }
  return shellCommand("pnpm", [...args, ...extra]);
}
function createReleaseState(options: ReleaseOptions): ReleaseState {
  const pending = (): ReleaseState["phases"]["cut"] => ({ status: "pending" });
  return {
    version: 1,
    release: options.release,
    tag: `v${options.release}`,
    branch: `release/${options.release}`,
    repo: options.repo,
    releasesRepo: options.releasesRepo,
    startedAt: new Date().toISOString(),
    operator: { name: options.operator, cutShaConfirmed: null, publicationApproved: null },
    phases: {
      cut: pending(),
      validate: pending(),
      publish: pending(),
      "sync-beta": pending(),
      "flip-github": pending(),
      macos: pending(),
      closeout: pending(),
    },
    cut: {},
    validate: {},
    publish: { approvedGates: [] },
    syncBeta: {},
    flipGithub: {},
    macos: {},
    closeout: {},
    history: [],
  };
}
export function loadReleaseState(options: ReleaseOptions): ReleaseState {
  const path = join(options.stateDir, "state.json");
  if (!existsSync(path)) {
    return createReleaseState(options);
  }
  try {
    const state = releaseStateReadSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (
      state.release !== options.release ||
      state.tag !== `v${options.release}` ||
      state.branch !== `release/${options.release}` ||
      state.repo !== options.repo ||
      state.releasesRepo !== options.releasesRepo
    ) {
      throw new Error("release or repository does not match this command");
    }
    return state;
  } catch (error) {
    throw new ReleaseRefusal(
      `Invalid state file ${path}: ${error instanceof Error ? error.message : String(error)}. Move the file aside before retrying.`,
      [shellCommand("mv", [path, `${path}.invalid-${Date.now()}`]), resumeCommand(options)],
    );
  }
}
export function saveReleaseState(options: ReleaseOptions, state: ReleaseState): void {
  if (options.dryRun) {
    return;
  }
  releaseStateSchema.parse(state);
  mkdirSync(options.stateDir, { recursive: true });
  const temporary = join(options.stateDir, `state.json.tmp-${randomUUID()}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, join(options.stateDir, "state.json"));
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function resetReleasePhases(state: ReleaseState, from: ReleasePhase): void {
  const data = {
    cut: state.cut,
    validate: state.validate,
    publish: state.publish,
    "sync-beta": state.syncBeta,
    "flip-github": state.flipGithub,
    macos: state.macos,
    closeout: state.closeout,
  };
  for (const phase of RELEASE_PHASES.slice(RELEASE_PHASES.indexOf(from))) {
    state.history.push({
      at: new Date().toISOString(),
      phase,
      event: "reset",
      detail: JSON.stringify({ phase: state.phases[phase], data: data[phase] }),
    });
    state.phases[phase] = { status: "pending" };
  }
}
type CommandResult = { stdout: string; stderr: string; exitCode: number };
type RunOptions = { allowFailure?: boolean; dryRunStdout?: string };
export type ReleaseRunner = (
  bin: string,
  args: string[],
  options?: RunOptions,
) => Promise<CommandResult>;
export type ReleaseContext = {
  options: ReleaseOptions;
  state: ReleaseState;
  run: ReleaseRunner;
  save: () => void;
  log: (phase: ReleasePhase, message: string) => void;
  resume: (phase?: ReleasePhase, extra?: string[]) => string;
};
function durationFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return Number(value);
}
function spawnCommand(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}
function isGhGet(bin: string, args: string[]): boolean {
  if (bin !== "gh" || args[0] !== "api") {
    return false;
  }
  const methodIndex = args.findIndex(
    (arg) => arg.startsWith("-X") || arg === "--method" || arg.startsWith("--method="),
  );
  const method = args[methodIndex];
  if (method !== undefined) {
    const value =
      method === "-X" || method === "--method"
        ? args[methodIndex + 1]
        : method.replace(/^(?:-X|--method=)/u, "");
    return value?.toUpperCase() === "GET";
  }
  if (args[1] === "graphql") {
    return false;
  }
  return !args.some(
    (arg) => /^-[fF]/u.test(arg) || /^(?:--field|--raw-field|--input)(?:=|$)/u.test(arg),
  );
}
export function createReleaseRunner(
  dryRun: boolean,
  execute: ReleaseRunner = spawnCommand,
): ReleaseRunner {
  return async (bin, args, options = {}) => {
    if (dryRun) {
      console.log(`+ ${shellCommand(bin, args)}`);
      return { stdout: options.dryRunStdout ?? "", stderr: "", exitCode: 0 };
    }
    const attempts = isGhGet(bin, args) ? 4 : 1;
    let result: CommandResult = { stdout: "", stderr: "", exitCode: 1 };
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        result = await execute(bin, args);
      } catch (error) {
        result = {
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        };
      }
      if (result.exitCode === 0) {
        return result;
      }
      if (attempt + 1 < attempts) {
        await delay(durationFromEnv("OPENCLAW_RELEASE_STABLE_BACKOFF_MS", 2000) * 2 ** attempt);
      }
    }
    if (!options.allowFailure) {
      throw new Error(
        `${shellCommand(bin, args)} failed (${result.exitCode}):\n${result.stderr || result.stdout}`,
      );
    }
    return result;
  };
}
export async function confirmRelease(
  ctx: ReleaseContext,
  question: string,
  next: string[],
): Promise<void> {
  if (ctx.options.dryRun) {
    console.log(`[release-stable] Would ask: ${question}`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ReleaseRefusal(`Non-interactive confirmation required: ${question}`, next);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!/^y(?:es)?$/iu.test((await prompt.question(`${question} `)).trim())) {
      throw new ReleaseRefusal("Operator declined confirmation", next);
    }
  } finally {
    prompt.close();
  }
}
export async function probeCapabilities(ctx: ReleaseContext, toolingSha: string): Promise<void> {
  if (
    !ctx.options.dryRun &&
    ctx.state.capabilities?.toolingSha === toolingSha &&
    ctx.state.capabilities.parentSweepsStaleChildren !== undefined &&
    ctx.state.capabilities.childNpmPublishEnvironment !== undefined
  ) {
    return;
  }
  const publisher = await ctx.run(
    "git",
    ["show", `${toolingSha}:.github/workflows/openclaw-release-publish.yml`],
    { allowFailure: true },
  );
  const children = await ctx.run(
    "git",
    ["show", `${toolingSha}:scripts/lib/release-publish-children.sh`],
    { allowFailure: true },
  );
  const npmPublisher = await ctx.run(
    "git",
    ["show", `${toolingSha}:.github/workflows/openclaw-npm-release.yml`],
    { allowFailure: true },
  );
  ctx.state.capabilities = {
    parentSweepsStaleChildren:
      !ctx.options.dryRun &&
      children.exitCode === 0 &&
      children.stdout.includes("sweep_superseded_children"),
    parentSyncsBetaDistTag:
      !ctx.options.dryRun &&
      ((publisher.exitCode === 0 && publisher.stdout.includes("sync_beta_to_stable")) ||
        (children.exitCode === 0 && children.stdout.includes("sync_beta_to_stable"))),
    childNpmPublishEnvironment:
      !ctx.options.dryRun &&
      npmPublisher.exitCode === 0 &&
      npmPublisher.stdout.includes("environment: npm-publish"),
    probedAt: new Date().toISOString(),
    toolingSha,
  };
  ctx.save();
}
export async function pollRelease<T>(
  ctx: ReleaseContext,
  options: {
    label: string;
    timeoutMs: number;
    next?: string[];
    probe: () => Promise<T | undefined>;
  },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  do {
    const result = await options.probe();
    if (result !== undefined) {
      return result;
    }
    if (ctx.options.dryRun) {
      throw new Error(`Missing dry-run placeholder for ${options.label}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(durationFromEnv("OPENCLAW_RELEASE_STABLE_POLL_MS", 30000), remaining));
  } while (Date.now() < deadline);
  throw new ReleaseRefusal(
    `Timed out waiting for ${options.label}`,
    options.next ?? [ctx.resume()],
  );
}
