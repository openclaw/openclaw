import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { installLobsterAjvCompileCache } from "./lobster-ajv-cache.js";

export type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
        approvalId?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

export type LobsterRunnerParams = {
  action: "run" | "resume";
  pipeline?: string;
  argsJson?: string;
  token?: string;
  approvalId?: string;
  approve?: boolean;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

export type LobsterRunner = {
  run: (params: LobsterRunnerParams) => Promise<LobsterEnvelope>;
};

type EmbeddedToolContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  registry?: unknown;
  llmAdapters?: Record<string, unknown>;
};

type EmbeddedCommandResult = {
  output?: AsyncIterable<unknown>;
  rendered?: boolean;
  halt?: boolean;
};

type EmbeddedCommand = {
  name: string;
  meta?: unknown;
  help?: () => string;
  run: (params: {
    input: AsyncIterable<unknown>;
    args: Record<string, unknown>;
    ctx: EmbeddedToolContext;
  }) => EmbeddedCommandResult | Promise<EmbeddedCommandResult>;
};

type EmbeddedRegistry = {
  get: (name: string) => EmbeddedCommand | undefined;
  list: () => string[];
};

type EmbeddedToolEnvelope = {
  protocolVersion?: number;
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    type?: "approval_request";
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: {
    prompt: string;
    schema?: unknown;
    items?: unknown[];
    resumeToken?: string;
    approvalId?: string;
  } | null;
  error?: {
    type?: string;
    message: string;
  };
};

type EmbeddedToolRuntime = {
  createDefaultRegistry?: () => EmbeddedRegistry;
  runToolRequest: (params: {
    pipeline?: string;
    filePath?: string;
    args?: Record<string, unknown>;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
  resumeToolRequest: (params: {
    token?: string;
    approvalId?: string;
    approved?: boolean;
    response?: unknown;
    cancel?: boolean;
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
};

type LoadEmbeddedToolRuntime = () => Promise<EmbeddedToolRuntime>;

export type OpenClawNativeToolInvoker = (params: {
  tool: string;
  action: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type OpenClawWorkflowResolver = (params: {
  workflowId: string;
  workflowRevision?: number;
}) => Promise<string>;

type LoadEmbeddedToolRuntimeFromPackageOptions = {
  importModule?: (specifier: string) => Promise<Partial<EmbeddedToolRuntime>>;
  resolvePackageEntry?: (specifier: string) => string;
};

const lobsterRequire = createRequire(import.meta.url);

function toEmbeddedToolRuntime(
  moduleExports: Partial<EmbeddedToolRuntime>,
  source: string,
): EmbeddedToolRuntime {
  const { runToolRequest, resumeToolRequest } = moduleExports;
  if (typeof runToolRequest === "function" && typeof resumeToolRequest === "function") {
    return {
      ...(typeof moduleExports.createDefaultRegistry === "function"
        ? { createDefaultRegistry: moduleExports.createDefaultRegistry }
        : {}),
      runToolRequest,
      resumeToolRequest,
    };
  }
  throw new Error(`${source} does not export Lobster embedded runtime functions`);
}

function findLobsterPackageRoot(resolvedEntryPath: string): string {
  let dir = path.dirname(resolvedEntryPath);
  while (true) {
    const packageJsonPath = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (parsed.name === "@clawdbot/lobster") {
        return dir;
      }
    } catch {
      // Keep walking until the installed package root is found.
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate @clawdbot/lobster package root from ${resolvedEntryPath}`);
    }
    dir = parent;
  }
}

function normalizeForCwdSandbox(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveLobsterCwd(cwdRaw: unknown): string {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);

  const rel = path.relative(normalizeForCwdSandbox(base), normalizeForCwdSandbox(resolved));
  if (rel === "" || rel === ".") {
    return resolved;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

function createLimitedSink(maxBytes: number, label: "stdout" | "stderr") {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(String(chunk), "utf8");
      if (bytes > maxBytes) {
        callback(new Error(`lobster ${label} exceeded maxStdoutBytes`));
        return;
      }
      callback();
    },
  });
}

function normalizeEnvelope(envelope: EmbeddedToolEnvelope): LobsterEnvelope {
  if (envelope.ok) {
    if (envelope.status === "needs_input") {
      return {
        ok: false,
        error: {
          type: "unsupported_status",
          message: "Lobster input requests are not supported by the OpenClaw Lobster tool yet",
        },
      };
    }
    return {
      ok: true,
      status: envelope.status ?? "ok",
      output: Array.isArray(envelope.output) ? envelope.output : [],
      requiresApproval: envelope.requiresApproval
        ? {
            type: "approval_request",
            prompt: envelope.requiresApproval.prompt,
            items: envelope.requiresApproval.items,
            ...(envelope.requiresApproval.resumeToken
              ? { resumeToken: envelope.requiresApproval.resumeToken }
              : {}),
            ...(envelope.requiresApproval.approvalId
              ? { approvalId: envelope.requiresApproval.approvalId }
              : {}),
          }
        : null,
    };
  }
  return {
    ok: false,
    error: {
      type: envelope.error?.type,
      message: envelope.error?.message ?? "lobster runtime failed",
    },
  };
}

function throwOnErrorEnvelope(envelope: LobsterEnvelope): Extract<LobsterEnvelope, { ok: true }> {
  if (envelope.ok) {
    return envelope;
  }
  const message = envelope.error.message;
  if (/^OpenClaw tool ".+" unavailable for invoking agent:/u.test(message)) {
    const err = new Error(message) as Error & { status?: number };
    err.name = "ToolAuthorizationError";
    err.status = 403;
    throw err;
  }
  throw new Error(message);
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error("Workflow path is not a file");
  }
  const ext = path.extname(resolved).toLowerCase();
  if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
  }
  return resolved;
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|")) {
    return null;
  }
  try {
    return await resolveWorkflowFile(trimmed, cwd);
  } catch {
    return null;
  }
}

function parseWorkflowArgs(argsJson: string) {
  return JSON.parse(argsJson) as Record<string, unknown>;
}

function quotePipelineArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function* streamFromItems(items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

async function drainInput(input: AsyncIterable<unknown>): Promise<void> {
  for await (const item of input) {
    void item;
    // Drain upstream pipeline input so the command keeps Lobster pipeline backpressure semantics.
  }
}

function readBooleanArg(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function readStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveIntegerArg(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgsJson(raw: unknown, commandName: string): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "string") {
    throw new Error(`${commandName} --args-json must be a JSON object`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${commandName} --args-json must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${commandName} --args-json must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function looksLikeWorkflowFile(value: string): boolean {
  return /\.(lobster|ya?ml|json)$/iu.test(value) || value.includes("/") || value.includes("\\");
}

function workflowStepArgs(step: Record<string, unknown>) {
  return isRecord(step.workflow_args) ? { ...step.workflow_args } : undefined;
}

function buildWorkflowPipeline(params: {
  workflowId?: string;
  workflowRevision?: number;
  file?: string;
  args?: Record<string, unknown>;
  inputKey?: string;
}) {
  const parts = ["lobster.workflow"];
  if (params.workflowId) {
    parts.push("--workflow-id", quotePipelineArg(params.workflowId));
    if (params.workflowRevision !== undefined) {
      parts.push("--workflow-revision", quotePipelineArg(String(params.workflowRevision)));
    }
  } else if (params.file) {
    parts.push("--file", quotePipelineArg(params.file));
  } else {
    throw new Error("workflow step requires workflowId or file");
  }
  if (params.args && Object.keys(params.args).length > 0) {
    parts.push("--args-json", quotePipelineArg(JSON.stringify(params.args)));
  }
  if (params.inputKey) {
    parts.push("--input-key", quotePipelineArg(params.inputKey));
  }
  return parts.join(" ");
}

function normalizeWorkflowReferenceStep(step: Record<string, unknown>): boolean {
  if (typeof step.pipeline === "string" && step.pipeline.trim()) {
    return false;
  }
  const workflowValue = readStringArg(step.workflow);
  if (!workflowValue) {
    return false;
  }

  const ref = isRecord(step.openclaw_workflow_ref) ? step.openclaw_workflow_ref : {};
  const refTarget = readStringArg(ref.target);
  const refWorkflowId = readStringArg(ref.workflowId);
  const refFile = readStringArg(ref.file);
  const revision =
    readPositiveIntegerArg(ref.workflowRevision, "workflowRevision") ??
    readPositiveIntegerArg(step.workflowRevision ?? step.workflow_revision, "workflowRevision");
  const args = workflowStepArgs(step);
  const inputKey =
    readStringArg(ref.inputKey) ??
    (typeof args?.input === "string" && args.input.trim() ? "input" : undefined);
  if (inputKey && args && inputKey in args) {
    step.stdin ??= args[inputKey];
    delete args[inputKey];
  }

  const targetIsFile =
    refTarget === "file" ||
    Boolean(refFile) ||
    (!refWorkflowId && looksLikeWorkflowFile(workflowValue));
  step.pipeline = buildWorkflowPipeline({
    ...(targetIsFile
      ? { file: refFile ?? workflowValue }
      : { workflowId: refWorkflowId ?? workflowValue }),
    ...(revision !== undefined ? { workflowRevision: revision } : {}),
    ...(args && Object.keys(args).length > 0 ? { args } : {}),
    ...(inputKey ? { inputKey } : {}),
  });
  return true;
}

function normalizeParallelBranch(value: unknown): { id: string; pipeline: string } | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readStringArg(value.id);
  const pipeline = readStringArg(value.pipeline);
  if (!id || !pipeline) {
    return null;
  }
  return { id, pipeline };
}

function normalizeParallelStep(step: Record<string, unknown>): boolean {
  if (typeof step.pipeline === "string" && step.pipeline.trim()) {
    return false;
  }
  const parallel = isRecord(step.parallel) ? step.parallel : undefined;
  const rawBranches = Array.isArray(parallel?.branches) ? parallel.branches : undefined;
  if (!rawBranches?.length) {
    return false;
  }

  const branches = rawBranches.map(normalizeParallelBranch);
  if (branches.some((branch) => branch === null)) {
    return false;
  }
  step.pipeline = `lobster.parallel --branches-json ${quotePipelineArg(JSON.stringify(branches))}`;
  return true;
}

function normalizeWorkflowReferencesInDocument(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return false;
  }
  let changed = false;
  for (const step of value.steps) {
    if (!isRecord(step)) {
      continue;
    }
    changed = normalizeWorkflowReferenceStep(step) || changed;
    changed = normalizeParallelStep(step) || changed;
  }
  return changed;
}

async function materializeOpenClawWorkflowFile(filePath: string): Promise<string> {
  const raw = await readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
  if (!normalizeWorkflowReferencesInDocument(parsed)) {
    return filePath;
  }
  const serialized = stringifyYaml(parsed);
  const hash = createHash("sha256").update(`${filePath}\0${serialized}`).digest("hex").slice(0, 16);
  const normalizedPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    "openclaw-lobster-workflows",
    `${hash}.lobster`,
  );
  await mkdir(path.dirname(normalizedPath), { recursive: true });
  await writeFile(normalizedPath, serialized, "utf8");
  return normalizedPath;
}

async function collectInput(input: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of input) {
    items.push(item);
  }
  return items;
}

function mergeWorkflowInputArgs(
  args: Record<string, unknown>,
  items: unknown[],
  inputKey: string,
): Record<string, unknown> {
  if (items.length === 0) {
    return args;
  }
  return {
    ...args,
    [inputKey]: items.length === 1 ? items[0] : items,
  };
}

function readWorkflowDepth(env: Record<string, string | undefined> | undefined): number {
  const value = Number(env?.OPENCLAW_LOBSTER_WORKFLOW_DEPTH);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function createLobsterWorkflowCommand(
  runtime: EmbeddedToolRuntime,
  resolvePublishedWorkflow?: OpenClawWorkflowResolver,
): EmbeddedCommand {
  return {
    name: "lobster.workflow",
    meta: {
      description: "Run a published or file-based Lobster workflow inside the current Lobster run",
      sideEffects: ["runs_lobster_workflow"],
    },
    async run({ input, args, ctx }) {
      const depth = readWorkflowDepth(ctx.env);
      if (depth >= 16) {
        throw new Error("Nested Lobster workflow depth exceeded");
      }

      const workflowId =
        readStringArg(args.workflowId) ??
        readStringArg(args["workflow-id"]) ??
        readStringArg(args.workflow);
      const file = readStringArg(args.file);
      if (workflowId && file) {
        throw new Error("lobster.workflow accepts workflow-id or file, not both");
      }
      if (!workflowId && !file) {
        throw new Error("lobster.workflow requires --workflow-id or --file");
      }

      const workflowRevision =
        readPositiveIntegerArg(args.workflowRevision, "workflowRevision") ??
        readPositiveIntegerArg(args["workflow-revision"], "workflowRevision");
      let filePath: string;
      if (workflowId) {
        if (!resolvePublishedWorkflow) {
          throw new Error("Published workflow resolution is unavailable");
        }
        filePath = await resolvePublishedWorkflow({ workflowId, workflowRevision });
      } else {
        filePath = await resolveWorkflowFile(String(file), ctx.cwd ?? process.cwd());
      }

      const baseArgs = parseArgsJson(args["args-json"], "lobster.workflow");
      const inputKey = readStringArg(args.inputKey) ?? readStringArg(args["input-key"]) ?? "input";
      const workflowArgs = mergeWorkflowInputArgs(baseArgs, await collectInput(input), inputKey);
      const workflowPath = await materializeOpenClawWorkflowFile(filePath);
      const envelope = await runtime.runToolRequest({
        filePath: workflowPath,
        args: workflowArgs,
        ctx: {
          ...ctx,
          env: {
            ...ctx.env,
            OPENCLAW_LOBSTER_WORKFLOW_DEPTH: String(depth + 1),
          },
        },
      });
      if (!envelope.ok) {
        throw new Error(envelope.error?.message ?? "nested Lobster workflow failed");
      }
      if (envelope.status === "needs_approval" || envelope.status === "needs_input") {
        throw new Error(
          `Nested Lobster workflow ${workflowId ?? file} paused for ${envelope.status}; nested pause/resume is not supported yet`,
        );
      }
      if (envelope.status === "cancelled") {
        return { output: streamFromItems([]) };
      }
      return { output: streamFromItems(Array.isArray(envelope.output) ? envelope.output : []) };
    },
  };
}

function parseParallelBranches(raw: unknown): Array<{ id: string; pipeline: string }> {
  if (typeof raw !== "string") {
    throw new Error("lobster.parallel --branches-json must be a JSON array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("lobster.parallel --branches-json must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("lobster.parallel --branches-json must be a non-empty JSON array");
  }

  return parsed.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`lobster.parallel branch ${index + 1} must be an object`);
    }
    const id = readStringArg(item.id);
    const pipeline = readStringArg(item.pipeline);
    if (!id) {
      throw new Error(`lobster.parallel branch ${index + 1} requires id`);
    }
    if (!pipeline) {
      throw new Error(`lobster.parallel branch ${id} requires pipeline`);
    }
    return { id, pipeline };
  });
}

function createLobsterParallelCommand(runtime: EmbeddedToolRuntime): EmbeddedCommand {
  return {
    name: "lobster.parallel",
    meta: {
      description:
        "Run multiple Lobster branch pipelines concurrently inside the current Lobster run",
      sideEffects: ["runs_parallel_lobster_branches"],
    },
    async run({ input, args, ctx }) {
      await drainInput(input);
      const branches = parseParallelBranches(args["branches-json"] ?? args.branchesJson);
      const results = await Promise.all(
        branches.map(async (branch) => {
          const envelope = await runtime.runToolRequest({
            pipeline: branch.pipeline,
            ctx,
          });
          if (!envelope.ok) {
            throw new Error(
              `lobster.parallel branch ${branch.id} failed: ${envelope.error?.message ?? "branch failed"}`,
            );
          }
          if (envelope.status === "needs_approval" || envelope.status === "needs_input") {
            throw new Error(
              `lobster.parallel branch ${branch.id} paused for ${envelope.status}; parallel pause/resume is not supported yet`,
            );
          }
          return {
            id: branch.id,
            status: envelope.status ?? "ok",
            output: Array.isArray(envelope.output) ? envelope.output : [],
          };
        }),
      );
      return { output: streamFromItems(results) };
    },
  };
}

function createOpenClawInvokeCommand(
  commandName: "openclaw.invoke" | "clawd.invoke",
  invokeNativeTool: OpenClawNativeToolInvoker,
): EmbeddedCommand {
  return {
    name: commandName,
    meta: {
      description: "Call an OpenClaw tool through the invoking agent's in-process tool context",
      sideEffects: ["calls_openclaw_tool"],
    },
    async run({ input, args, ctx }) {
      if (args.url !== undefined || args.token !== undefined) {
        throw new Error(
          `${commandName} runs in-process inside OpenClaw; --url and --token are not accepted`,
        );
      }
      if (args.sessionKey !== undefined || args["session-key"] !== undefined) {
        throw new Error(
          `${commandName} uses the invoking agent session; --session-key is not accepted`,
        );
      }

      const tool = readStringArg(args.tool);
      const action = readStringArg(args.action);
      if (!tool || !action) {
        throw new Error(`${commandName} requires --tool and --action`);
      }

      const toolArgs = parseArgsJson(args["args-json"], commandName);
      const each = readBooleanArg(args.each);
      const itemKey = readStringArg(args.itemKey) ?? readStringArg(args["item-key"]) ?? "item";
      const idempotencyKey =
        readStringArg(args.idempotencyKey) ?? readStringArg(args["idempotency-key"]);
      const dryRun =
        args.dryRun !== undefined || args["dry-run"] !== undefined
          ? readBooleanArg(args.dryRun ?? args["dry-run"])
          : undefined;

      if (!each) {
        await drainInput(input);
        const result = await invokeNativeTool({
          tool,
          action,
          args: toolArgs,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
        });
        return { output: streamFromItems(Array.isArray(result) ? result : [result]) };
      }

      const output: unknown[] = [];
      for await (const item of input) {
        const result = await invokeNativeTool({
          tool,
          action,
          args: { ...toolArgs, [itemKey]: item },
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
        });
        output.push(...(Array.isArray(result) ? result : [result]));
      }
      return { output: streamFromItems(output) };
    },
  };
}

function createOpenClawRegistry(
  base: EmbeddedRegistry,
  options: {
    invokeNativeTool?: OpenClawNativeToolInvoker;
    workflowCommand?: EmbeddedCommand;
    parallelCommand?: EmbeddedCommand;
  },
): EmbeddedRegistry {
  const openclawInvoke = options.invokeNativeTool
    ? createOpenClawInvokeCommand("openclaw.invoke", options.invokeNativeTool)
    : undefined;
  const clawdInvoke = options.invokeNativeTool
    ? createOpenClawInvokeCommand("clawd.invoke", options.invokeNativeTool)
    : undefined;
  return {
    get(name) {
      if (openclawInvoke && name === openclawInvoke.name) {
        return openclawInvoke;
      }
      if (clawdInvoke && name === clawdInvoke.name) {
        return clawdInvoke;
      }
      if (options.workflowCommand && name === options.workflowCommand.name) {
        return options.workflowCommand;
      }
      if (options.parallelCommand && name === options.parallelCommand.name) {
        return options.parallelCommand;
      }
      return base.get(name);
    },
    list() {
      return Array.from(
        new Set([
          ...base.list(),
          ...(openclawInvoke ? [openclawInvoke.name] : []),
          ...(clawdInvoke ? [clawdInvoke.name] : []),
          ...(options.workflowCommand ? [options.workflowCommand.name] : []),
          ...(options.parallelCommand ? [options.parallelCommand.name] : []),
        ]),
      ).toSorted();
    },
  };
}

function createEmbeddedToolContext(
  params: LobsterRunnerParams,
  runtime: EmbeddedToolRuntime,
  options?: {
    nativeToolInvoker?: OpenClawNativeToolInvoker;
    workflowResolver?: OpenClawWorkflowResolver;
  },
  signal?: AbortSignal,
): EmbeddedToolContext {
  const env = { ...process.env } as Record<string, string | undefined>;
  const baseRegistry = runtime.createDefaultRegistry?.();
  const workflowCommand = createLobsterWorkflowCommand(runtime, options?.workflowResolver);
  const parallelCommand = createLobsterParallelCommand(runtime);
  const registry = baseRegistry
    ? createOpenClawRegistry(baseRegistry, {
        invokeNativeTool: options?.nativeToolInvoker,
        workflowCommand,
        parallelCommand,
      })
    : undefined;
  return {
    cwd: params.cwd,
    env,
    mode: "tool",
    stdin: Readable.from([]),
    stdout: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stdout"),
    stderr: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stderr"),
    signal,
    ...(registry ? { registry } : {}),
  };
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = Math.max(200, timeoutMs);
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    const onTimeout = () => {
      const error = new Error("lobster runtime timed out");
      controller.abort(error);
      reject(error);
    };

    const timer = setTimeout(onTimeout, timeout);
    void fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function loadEmbeddedToolRuntimeFromPackage(
  options: LoadEmbeddedToolRuntimeFromPackageOptions = {},
): Promise<EmbeddedToolRuntime> {
  installLobsterAjvCompileCache();

  const importModule =
    options.importModule ??
    (async (specifier: string) => (await import(specifier)) as Partial<EmbeddedToolRuntime>);
  const resolvePackageEntry =
    options.resolvePackageEntry ?? ((specifier: string) => lobsterRequire.resolve(specifier));

  let coreLoadError: unknown;
  try {
    const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
    return toEmbeddedToolRuntime(await importModule(coreSpecifier), "@clawdbot/lobster/core");
  } catch (error) {
    coreLoadError = error;
  }

  let fallbackLoadError: unknown;
  try {
    const packageEntryPath = resolvePackageEntry("@clawdbot/lobster");
    const packageRoot = findLobsterPackageRoot(packageEntryPath);
    const coreRuntimeUrl = pathToFileURL(path.join(packageRoot, "dist/src/core/index.js")).href;
    return toEmbeddedToolRuntime(await importModule(coreRuntimeUrl), coreRuntimeUrl);
  } catch (error) {
    fallbackLoadError = error;
  }

  throw new Error("Failed to load the Lobster embedded runtime", {
    cause: new AggregateError(
      [coreLoadError, fallbackLoadError],
      "Both Lobster embedded runtime load paths failed",
    ),
  });
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: LoadEmbeddedToolRuntime;
  nativeToolInvoker?: OpenClawNativeToolInvoker;
  workflowResolver?: OpenClawWorkflowResolver;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(params.timeoutMs, async (signal) => {
        const ctx = createEmbeddedToolContext(
          params,
          runtime,
          {
            nativeToolInvoker: options?.nativeToolInvoker,
            workflowResolver: options?.workflowResolver,
          },
          signal,
        );

        if (params.action === "run") {
          const pipeline = params.pipeline?.trim() ?? "";
          if (!pipeline) {
            throw new Error("pipeline required");
          }

          const filePath = await detectWorkflowFile(pipeline, params.cwd);
          if (filePath) {
            const parsedArgsJson = params.argsJson?.trim() ?? "";
            let args: Record<string, unknown> | undefined;
            if (parsedArgsJson) {
              try {
                args = parseWorkflowArgs(parsedArgsJson);
              } catch {
                throw new Error("run --args-json must be valid JSON");
              }
            }
            const workflowPath = await materializeOpenClawWorkflowFile(filePath);
            return throwOnErrorEnvelope(
              normalizeEnvelope(
                await runtime.runToolRequest({ filePath: workflowPath, args, ctx }),
              ),
            );
          }

          return throwOnErrorEnvelope(
            normalizeEnvelope(await runtime.runToolRequest({ pipeline, ctx })),
          );
        }

        const token = params.token?.trim() ?? "";
        const approvalId = params.approvalId?.trim() ?? "";
        if (!token && !approvalId) {
          throw new Error("token or approvalId required");
        }
        if (typeof params.approve !== "boolean") {
          throw new Error("approve required");
        }

        return throwOnErrorEnvelope(
          normalizeEnvelope(
            await runtime.resumeToolRequest({
              ...(token ? { token } : {}),
              ...(approvalId ? { approvalId } : {}),
              approved: params.approve,
              ctx,
            }),
          ),
        );
      });
    },
  };
}
