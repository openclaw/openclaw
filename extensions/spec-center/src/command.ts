import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/core";
import { resolveStateDir } from "../api.js";
import { importSpecFromSource } from "./importer.js";
import { checkSpec, formatRunPreview, formatSpecCheck } from "./preview.js";
import { createPreviewRun } from "./runtime.js";
import { createSpecCenterStore } from "./store.js";
import type {
  ImportSpecInput,
  SpecApprovalRecord,
  SpecArtifactName,
  SpecCenterState,
  SpecOptimizationRecord,
  SpecRecord,
  SpecScheduleRecord,
} from "./types.js";

export function registerSpecCommand(api: OpenClawPluginApi): void {
  api.registerCommand(createSpecCommand(api));
}

export function createSpecCommand(api: OpenClawPluginApi): OpenClawPluginCommandDefinition {
  return {
    name: "spec",
    description: "Manage Markdown-first specs and run previews.",
    acceptsArgs: true,
    handler: async (ctx) => handleSpecCommand({ api, ctx }),
  };
}

async function handleSpecCommand(params: {
  api: OpenClawPluginApi;
  ctx: PluginCommandContext;
}): Promise<PluginCommandResult> {
  const args = tokenize(params.ctx.args ?? "");
  const action = args[0]?.toLowerCase() ?? "help";
  const store = createSpecCenterStore({
    stateDir: params.api.runtime.state?.resolveStateDir?.() ?? resolveStateDir(),
  });

  try {
    switch (action) {
      case "init":
        return await handleInit({ store, args });
      case "import":
        return await handleImport({ store, args });
      case "list":
        return { text: formatSpecList(await store.load()) };
      case "status":
        return { text: formatStatus(await store.load(), args[1]) };
      case "check":
        return { text: await handleCheck({ store, args }) };
      case "preview":
      case "run":
        return { text: await handleRunPreview({ api: params.api, store, args, ctx: params.ctx }) };
      case "schedule":
        return { text: await handleSchedule({ store, args }) };
      case "pause":
        return { text: await handleScheduleStatus({ store, args, status: "paused" }) };
      case "resume":
        return { text: await handleScheduleStatus({ store, args, status: "active" }) };
      case "report":
        return { text: await handleReport({ store, args }) };
      case "optimize":
        return { text: await handleOptimize({ store, args }) };
      case "approve":
        return { text: await handleApprove({ store, args, ctx: params.ctx }) };
      case "help":
      default:
        return { text: formatHelp() };
    }
  } catch (error) {
    return { text: `Spec Center error: ${(error as Error).message}` };
  }
}

async function handleInit(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
}): Promise<PluginCommandResult> {
  const flags = parseFlags(params.args.slice(1));
  const state = await params.store.load();
  const next: SpecCenterState = {
    ...state,
    ...(flags.team ? { team: flags.team } : {}),
    ...(flags.owner ? { owner: flags.owner } : {}),
    approvers: flags.approvers ? flags.approvers.split(",").filter(Boolean) : state.approvers,
  };
  await params.store.save(next);
  return {
    text: [
      "Spec Center initialized.",
      `- team: ${next.team ?? "unset"}`,
      `- owner: ${next.owner ?? "unset"}`,
      `- approvers: ${next.approvers.length > 0 ? next.approvers.join(", ") : "unset"}`,
    ].join("\n"),
  };
}

async function handleImport(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
}): Promise<PluginCommandResult> {
  const input = parseImportInput(params.args.slice(1));
  const result = await importSpecFromSource(input);
  await params.store.upsertSpec(result.spec);
  return {
    text: [
      "Spec imported.",
      `- specId: ${result.spec.id}`,
      `- title: ${result.spec.title}`,
      `- source: ${result.spec.source.repo}${result.spec.source.path === "." ? "" : `/${result.spec.source.path}`}`,
      `- artifacts: ${result.spec.artifacts.length}`,
      `- steps: ${result.spec.steps.length}`,
      `- check: ${result.check.ok ? "passed" : "failed"}`,
      result.spec.warnings.length > 0
        ? `- warnings: ${result.spec.warnings.map((warning) => warning.code).join(", ")}`
        : undefined,
      "",
      formatRunPreview(result.preview),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
}

async function handleCheck(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
}): Promise<string> {
  const spec = await requireSpec(params.store, params.args[1]);
  return formatSpecCheck(checkSpec(spec));
}

async function handleRunPreview(params: {
  api: OpenClawPluginApi;
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
  ctx: PluginCommandContext;
}): Promise<string> {
  const spec = await requireSpec(params.store, params.args[1]);
  const run = createPreviewRun({
    api: params.api,
    spec,
    sessionKey: params.ctx.sessionKey,
  });
  await params.store.appendRun(run);
  return [
    "Spec run preview created.",
    `- runId: ${run.runId}`,
    run.flowId ? `- flowId: ${run.flowId}` : "- flowId: not created (no sessionKey/runtime)",
    "",
    formatRunPreview(run.preview),
  ].join("\n");
}

async function handleSchedule(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
}): Promise<string> {
  const spec = await requireSpec(params.store, params.args[1]);
  const flags = parseFlags(params.args.slice(2));
  const now = new Date().toISOString();
  const schedule: SpecScheduleRecord = {
    specId: spec.id,
    cron: flags.cron ?? "0 9 * * 1-5",
    timezone: flags.timezone ?? "Asia/Shanghai",
    reportTo: flags.reportTo ?? "this_chat",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await params.store.upsertSchedule(schedule);
  return formatSchedule(schedule);
}

async function handleScheduleStatus(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
  status: SpecScheduleRecord["status"];
}): Promise<string> {
  const spec = await requireSpec(params.store, params.args[1]);
  const state = await params.store.updateScheduleStatus(spec.id, params.status);
  const schedule = state.schedules[spec.id];
  if (!schedule) {
    throw new Error(`No schedule found for spec: ${spec.id}`);
  }
  return formatSchedule(schedule);
}

async function handleReport(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
}): Promise<string> {
  const state = await params.store.load();
  const spec = requireSpecFromState(state, params.args[1]);
  const latestRun = state.runs.find((run) => run.specId === spec.id);
  const latestOptimization = state.optimizations.find((item) => item.specId === spec.id);
  const schedule = state.schedules[spec.id];

  return [
    `Spec Daily Report: ${spec.title}`,
    `- specId: ${spec.id}`,
    `- targetRepo: ${spec.targetRepo ?? "unset"}`,
    `- schedule: ${schedule ? `${schedule.cron} ${schedule.timezone} (${schedule.status})` : "not scheduled"}`,
    `- latestRun: ${latestRun ? `${latestRun.runId} (${latestRun.status})` : "none"}`,
    `- validation lanes: ${formatInlineList(latestRun?.preview.validationSteps ?? [])}`,
    `- approval steps: ${formatInlineList(latestRun?.preview.approvalSteps ?? [])}`,
    `- latest optimization: ${latestOptimization ? `${latestOptimization.optimizationId} (${latestOptimization.status})` : "none"}`,
  ].join("\n");
}

async function handleOptimize(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
}): Promise<string> {
  const spec = await requireSpec(params.store, params.args[1]);
  const instruction = params.args.slice(2).join(" ").trim();
  if (!instruction) {
    throw new Error("Usage: /spec optimize <specId> <instruction>");
  }
  const state = await params.store.load();
  const latestRun = state.runs.find((run) => run.specId === spec.id);
  const optimization = buildOptimizationPreview({
    spec,
    instruction,
    sourceRunId: latestRun?.runId,
  });
  await params.store.appendOptimization(optimization);
  return formatOptimizationPreview(optimization);
}

async function handleApprove(params: {
  store: ReturnType<typeof createSpecCenterStore>;
  args: string[];
  ctx: PluginCommandContext;
}): Promise<string> {
  const flags = parseFlags(params.args.slice(1));
  const targetId = params.args.find((arg) => arg.startsWith("opt-")) ?? flags.optimizationId;
  if (!targetId) {
    throw new Error("Usage: /spec approve <optimizationId> [decision=approved|rejected]");
  }
  const decision = normalizeApprovalDecision(flags.decision ?? "approved");
  const state = await params.store.updateOptimization(targetId, { status: decision });
  const optimization = state.optimizations.find((item) => item.optimizationId === targetId);
  if (!optimization) {
    throw new Error(`Spec optimization not found: ${targetId}`);
  }
  const approval: SpecApprovalRecord = {
    approvalId: `approval-${Date.now()}`,
    specId: optimization.specId,
    targetType: "spec_optimization",
    targetId,
    decision,
    createdAt: new Date().toISOString(),
    ...(params.ctx.senderId ? { actor: params.ctx.senderId } : {}),
    ...(flags.note ? { note: flags.note } : {}),
  };
  await params.store.appendApproval(approval);
  return [
    "Spec approval recorded.",
    `- approvalId: ${approval.approvalId}`,
    `- target: ${approval.targetId}`,
    `- decision: ${approval.decision}`,
    `- next: ${approval.decision === "approved" ? "create an MR with the proposed Markdown spec changes" : "keep the current spec unchanged"}`,
  ].join("\n");
}

async function requireSpec(
  store: ReturnType<typeof createSpecCenterStore>,
  maybeId: string | undefined,
): Promise<SpecRecord> {
  return requireSpecFromState(await store.load(), maybeId);
}

function requireSpecFromState(state: SpecCenterState, maybeId: string | undefined): SpecRecord {
  const id = maybeId ?? Object.keys(state.specs)[0];
  if (!id) {
    throw new Error("No spec imported yet. Use /spec import first.");
  }
  const spec = state.specs[id];
  if (!spec) {
    throw new Error(`Spec not found: ${id}`);
  }
  return spec;
}

function parseImportInput(args: string[]): ImportSpecInput {
  const flags = parseFlags(args);
  const positional = args.filter((arg) => !arg.includes("="));
  return {
    id: flags.id ?? positional[0],
    repo: flags.repo,
    ref: flags.ref,
    path: flags.path,
    targetRepo: flags.targetRepo,
  };
}

function formatSpecList(state: SpecCenterState): string {
  const specs = Object.values(state.specs);
  if (specs.length === 0) {
    return "No specs imported.";
  }
  return [
    "Imported specs:",
    ...specs.map((spec) => `- ${spec.id}: ${spec.title} (${spec.status})`),
  ].join("\n");
}

function formatStatus(state: SpecCenterState, maybeId: string | undefined): string {
  const specs = Object.values(state.specs);
  const spec = maybeId ? state.specs[maybeId] : specs[0];
  if (!spec) {
    return "No specs imported.";
  }
  const latestRun = state.runs.find((run) => run.specId === spec.id);
  const schedule = state.schedules[spec.id];
  const latestOptimization = state.optimizations.find((item) => item.specId === spec.id);
  return [
    `Spec status: ${spec.title}`,
    `- specId: ${spec.id}`,
    `- status: ${spec.status}`,
    `- source: ${spec.source.repo}${spec.source.path === "." ? "" : `/${spec.source.path}`}`,
    `- steps: ${spec.steps.length}`,
    `- schedule: ${schedule ? `${schedule.cron} ${schedule.timezone} (${schedule.status})` : "none"}`,
    `- latest run: ${latestRun ? `${latestRun.runId} (${latestRun.status})` : "none"}`,
    `- latest optimization: ${latestOptimization ? `${latestOptimization.optimizationId} (${latestOptimization.status})` : "none"}`,
  ].join("\n");
}

function formatSchedule(schedule: SpecScheduleRecord): string {
  return [
    "Spec schedule updated.",
    `- specId: ${schedule.specId}`,
    `- cron: ${schedule.cron}`,
    `- timezone: ${schedule.timezone}`,
    `- reportTo: ${schedule.reportTo}`,
    `- status: ${schedule.status}`,
  ].join("\n");
}

function buildOptimizationPreview(params: {
  spec: SpecRecord;
  instruction: string;
  sourceRunId?: string;
}): SpecOptimizationRecord {
  const lower = params.instruction.toLowerCase();
  const proposedFiles = new Set<SpecArtifactName>();
  proposedFiles.add("requirements.md");
  proposedFiles.add("coverage.md");
  if (
    lower.includes("task") ||
    lower.includes("lane") ||
    lower.includes("\u6821\u9a8c") ||
    lower.includes("\u9a8c\u8bc1") ||
    lower.includes("validation")
  ) {
    proposedFiles.add("tasks.md");
  }
  if (lower.includes("runbook") || lower.includes("\u5ba1\u6279") || lower.includes("approval")) {
    proposedFiles.add("runbook.md");
  }

  return {
    optimizationId: `opt-${Date.now()}`,
    specId: params.spec.id,
    instruction: params.instruction,
    status: "previewed",
    createdAt: new Date().toISOString(),
    ...(params.sourceRunId ? { sourceRunId: params.sourceRunId } : {}),
    proposedFiles: [...proposedFiles],
    proposedChanges: [
      "Add or update the requirement that captures the missing coverage.",
      "Update coverage.md so future reports can track whether the gap is closed.",
      proposedFiles.has("tasks.md")
        ? "Add or update a validation task in tasks.md for the newly required lane."
        : "Keep the existing execution tasks unchanged.",
    ],
    risk: "Changes scheduled validation behavior; approval is required before MR creation.",
    dryRun: "passed",
    dryRunReason: "Preview only; no repository files, branches, or schedules were modified.",
  };
}

function formatOptimizationPreview(optimization: SpecOptimizationRecord): string {
  return [
    "Spec optimization preview created.",
    `- optimizationId: ${optimization.optimizationId}`,
    `- specId: ${optimization.specId}`,
    `- sourceRunId: ${optimization.sourceRunId ?? "none"}`,
    `- proposed files: ${optimization.proposedFiles.join(", ")}`,
    `- risk: ${optimization.risk}`,
    `- dry-run: ${optimization.dryRun} (${optimization.dryRunReason})`,
    "",
    "Proposed changes:",
    ...optimization.proposedChanges.map((change) => `- ${change}`),
    "",
    `Approve with: /spec approve ${optimization.optimizationId}`,
  ].join("\n");
}

function formatHelp(): string {
  return [
    "Spec Center commands:",
    "- /spec init team=<team> owner=<owner> approvers=@a,@b",
    "- /spec import id=<specId> repo=<local path> path=<spec dir> targetRepo=<owner/repo>",
    "- /spec list",
    "- /spec check <specId>",
    "- /spec preview <specId>",
    '- /spec schedule <specId> cron="0 9 * * 1-5" timezone=Asia/Shanghai reportTo=this_chat',
    "- /spec report <specId>",
    '- /spec optimize <specId> "describe the missing coverage or spec change"',
    "- /spec approve <optimizationId> decision=approved|rejected",
    "- /spec pause <specId>",
    "- /spec resume <specId>",
    "- /spec status <specId>",
    "",
    "P0 supports local repo-backed Markdown specs, legacy YAML conversion, run previews, schedule records, report summaries, and spec optimization previews. Remote Git import, real Cron execution, interactive Feishu cards, and MR creation are follow-up slices.",
  ].join("\n");
}

function normalizeApprovalDecision(value: string): SpecOptimizationRecord["status"] {
  switch (value) {
    case "approved":
    case "rejected":
    case "changes_requested":
      return value;
    default:
      throw new Error("decision must be approved, rejected, or changes_requested");
  }
}

function formatInlineList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const index = arg.indexOf("=");
    if (index <= 0) {
      continue;
    }
    flags[arg.slice(0, index)] = unquote(arg.slice(index + 1));
  }
  return flags;
}

function tokenize(input: string): string[] {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map(unquote);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function createArkclawImportExample(repoPath: string): string {
  return `/spec import id=arkclaw-plugins-daily-run repo=${repoPath} path=specs/arkclaw-plugins-daily targetRepo=openclaw/openclaw`;
}
