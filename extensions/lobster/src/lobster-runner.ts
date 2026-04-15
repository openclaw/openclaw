import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

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

type ParsedPipelineStage = {
  name: string;
  args: Record<string, unknown> & {
    _: string[];
  };
  raw?: string;
};

type CompatPipelineResult = {
  items: unknown[];
  halted: boolean;
  haltedAt?: {
    index?: number;
  } | null;
  rendered?: boolean;
};

type CompatRegistry = {
  get: (name: string) => unknown;
  list: () => string[];
};

type ApprovalRequestPayload = {
  type: "approval_request";
  prompt: string;
  items: unknown[];
  preview?: string;
  resumeToken?: string;
};

type WorkflowFileResult = {
  status: "ok" | "needs_approval";
  output: unknown[];
  requiresApproval?: ApprovalRequestPayload | null;
};

type ResumeTokenPayload = {
  kind?: string;
  filePath?: string;
  stateKey?: string;
  pipeline?: ParsedPipelineStage[];
  resumeAtIndex?: number;
  items?: unknown[];
};

type LobsterPackageCompatModules = {
  parsePipeline: (input: string) => ParsedPipelineStage[];
  createDefaultRegistry: () => CompatRegistry;
  runPipeline: (params: {
    pipeline: ParsedPipelineStage[];
    registry: CompatRegistry;
    input: AsyncIterable<unknown> | unknown[];
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    env?: Record<string, string | undefined>;
    mode?: "tool" | "human" | "sdk";
  }) => Promise<CompatPipelineResult>;
  encodeToken: (payload: unknown) => string;
  decodeResumeToken: (token: string) => ResumeTokenPayload;
  runWorkflowFile: (params: {
    filePath?: string;
    args?: Record<string, unknown>;
    ctx: EmbeddedToolContext;
    resume?: ResumeTokenPayload;
    approved?: boolean;
  }) => Promise<WorkflowFileResult>;
};

const lobsterRequire = createRequire(import.meta.url);
let compatRuntimeCwdQueue: Promise<void> = Promise.resolve();

function isApprovalRequestPayload(value: unknown): value is ApprovalRequestPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ApprovalRequestPayload>;
  return (
    candidate.type === "approval_request" &&
    typeof candidate.prompt === "string" &&
    Array.isArray(candidate.items)
  );
}

function toEmbeddedToolError(
  error: unknown,
  type = "runtime_error",
): Extract<EmbeddedToolEnvelope, { ok: false }> {
  return {
    ok: false,
    error: {
      type,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function toEmbeddedApprovalRequest(
  payload: ApprovalRequestPayload | null | undefined,
): EmbeddedToolEnvelope["requiresApproval"] {
  if (!payload) {
    return null;
  }
  return {
    type: "approval_request",
    prompt: payload.prompt,
    items: payload.items,
    ...(payload.preview ? { preview: payload.preview } : {}),
    ...(payload.resumeToken ? { resumeToken: payload.resumeToken } : {}),
  };
}

function toAsyncInput(items: unknown[]) {
  return (async function* () {
    for (const item of items) {
      yield item;
    }
  })();
}

export async function withSerializedCompatCwd<T>(
  cwd: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = compatRuntimeCwdQueue;
  let release: (() => void) | undefined;
  compatRuntimeCwdQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  const originalCwd = process.cwd();
  let changedCwd = false;
  try {
    if (cwd && cwd !== originalCwd) {
      process.chdir(cwd);
      changedCwd = true;
    }
    return await fn();
  } finally {
    try {
      if (changedCwd) {
        process.chdir(originalCwd);
      }
    } finally {
      release?.();
    }
  }
}

function createCompatContext(
  ctx: EmbeddedToolContext | undefined,
  registry: CompatRegistry,
): EmbeddedToolContext & {
  env: Record<string, string | undefined>;
  mode: "tool" | "human" | "sdk";
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  registry: CompatRegistry;
} {
  return {
    cwd: ctx?.cwd,
    env: ctx?.env ?? ({ ...process.env } as Record<string, string | undefined>),
    mode: ctx?.mode ?? "tool",
    stdin: ctx?.stdin ?? Readable.from([]),
    stdout: ctx?.stdout ?? createLimitedSink(1024 * 1024, "stdout"),
    stderr: ctx?.stderr ?? createLimitedSink(1024 * 1024, "stderr"),
    signal: ctx?.signal,
    registry,
    llmAdapters: ctx?.llmAdapters,
  };
}

function normalizeWorkflowToolEnvelope(result: WorkflowFileResult): EmbeddedToolEnvelope {
  if (result.status === "needs_approval") {
    return {
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: toEmbeddedApprovalRequest(result.requiresApproval),
    };
  }

  return {
    ok: true,
    status: "ok",
    output: Array.isArray(result.output) ? result.output : [],
    requiresApproval: null,
  };
}

function normalizePipelineToolEnvelope(params: {
  encodeToken: (payload: unknown) => string;
  pipeline: ParsedPipelineStage[];
  result: CompatPipelineResult;
}): EmbeddedToolEnvelope {
  const approvalCandidate =
    params.result.halted && params.result.items.length === 1 ? params.result.items[0] : null;

  if (isApprovalRequestPayload(approvalCandidate)) {
    const resumeToken = params.encodeToken({
      protocolVersion: 1,
      v: 1,
      pipeline: params.pipeline,
      resumeAtIndex: (params.result.haltedAt?.index ?? -1) + 1,
      items: approvalCandidate.items,
      prompt: approvalCandidate.prompt,
    });

    return {
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: toEmbeddedApprovalRequest({
        ...approvalCandidate,
        resumeToken,
      }),
    };
  }

  return {
    ok: true,
    status: "ok",
    output: Array.isArray(params.result.items) ? params.result.items : [],
    requiresApproval: null,
  };
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
      // Keep walking upward until we reach the package root.
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate @clawdbot/lobster package root from ${resolvedEntryPath}`);
    }
    dir = parent;
  }
}

async function importLobsterModule<T>(packageRoot: string, relativePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(path.join(packageRoot, relativePath)).href;
  return (await import(moduleUrl)) as T;
}

function createCompatEmbeddedToolRuntime(
  modules: LobsterPackageCompatModules,
): EmbeddedToolRuntime {
  const registry = modules.createDefaultRegistry();

  return {
    async runToolRequest(params) {
      try {
        const ctx = createCompatContext(params.ctx, registry);
        return await withSerializedCompatCwd(ctx.cwd, async () => {
          if (params.filePath) {
            return normalizeWorkflowToolEnvelope(
              await modules.runWorkflowFile({
                filePath: params.filePath,
                args: params.args,
                ctx,
              }),
            );
          }

          const pipeline = params.pipeline?.trim() ?? "";
          if (!pipeline) {
            return toEmbeddedToolError(new Error("pipeline required"), "parse_error");
          }

          const parsedPipeline = modules.parsePipeline(pipeline);
          return normalizePipelineToolEnvelope({
            encodeToken: modules.encodeToken,
            pipeline: parsedPipeline,
            result: await modules.runPipeline({
              pipeline: parsedPipeline,
              registry,
              input: [],
              stdin: ctx.stdin,
              stdout: ctx.stdout,
              stderr: ctx.stderr,
              env: ctx.env,
              mode: ctx.mode,
            }),
          });
        });
      } catch (error) {
        return toEmbeddedToolError(error);
      }
    },
    async resumeToolRequest(params) {
      try {
        if (!params.approved || params.cancel) {
          return {
            ok: true,
            status: "cancelled",
            output: [],
            requiresApproval: null,
          };
        }

        const token = params.token?.trim() ?? "";
        if (!token) {
          return toEmbeddedToolError(new Error("token required"), "parse_error");
        }

        const payload = modules.decodeResumeToken(token);
        const ctx = createCompatContext(params.ctx, registry);

        return await withSerializedCompatCwd(ctx.cwd, async () => {
          if (payload.kind === "workflow-file") {
            return normalizeWorkflowToolEnvelope(
              await modules.runWorkflowFile({
                filePath: payload.filePath,
                ctx,
                resume: payload,
                approved: true,
              }),
            );
          }

          const pipeline = Array.isArray(payload.pipeline)
            ? payload.pipeline.slice(payload.resumeAtIndex ?? 0)
            : null;
          if (!pipeline) {
            return toEmbeddedToolError(new Error("Invalid token"), "parse_error");
          }

          return normalizePipelineToolEnvelope({
            encodeToken: modules.encodeToken,
            pipeline,
            result: await modules.runPipeline({
              pipeline,
              registry,
              input: toAsyncInput(Array.isArray(payload.items) ? payload.items : []),
              stdin: ctx.stdin,
              stdout: ctx.stdout,
              stderr: ctx.stderr,
              env: ctx.env,
              mode: ctx.mode,
            }),
          });
        });
      } catch (error) {
        return toEmbeddedToolError(error);
      }
    },
  };
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
  throw new Error(envelope.error.message);
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const { stat } = await import("node:fs/promises");
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

function createEmbeddedToolContext(
  params: LobsterRunnerParams,
  signal?: AbortSignal,
): EmbeddedToolContext {
  const env = { ...process.env } as Record<string, string | undefined>;
  return {
    cwd: params.cwd,
    env,
    mode: "tool",
    stdin: Readable.from([]),
    stdout: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stdout"),
    stderr: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stderr"),
    signal,
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

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  let primaryLoadError: unknown;
  try {
    // Split to prevent static bundler resolution of this optional entrypoint.
    const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
    const coreModule = (await import(coreSpecifier)) as Partial<EmbeddedToolRuntime>;
    if (
      typeof coreModule.runToolRequest === "function" &&
      typeof coreModule.resumeToolRequest === "function"
    ) {
      return {
        runToolRequest: coreModule.runToolRequest,
        resumeToolRequest: coreModule.resumeToolRequest,
      };
    }
  } catch (error) {
    primaryLoadError = error;
  }

  try {
    const packageEntryPath = lobsterRequire.resolve("@clawdbot/lobster");
    const packageRoot = findLobsterPackageRoot(packageEntryPath);
    const [
      parserModule,
      registryModule,
      runtimeModule,
      tokenModule,
      resumeModule,
      workflowFileModule,
    ] = await Promise.all([
      importLobsterModule<{ parsePipeline: LobsterPackageCompatModules["parsePipeline"] }>(
        packageRoot,
        "dist/src/parser.js",
      ),
      importLobsterModule<{
        createDefaultRegistry: LobsterPackageCompatModules["createDefaultRegistry"];
      }>(packageRoot, "dist/src/commands/registry.js"),
      importLobsterModule<{ runPipeline: LobsterPackageCompatModules["runPipeline"] }>(
        packageRoot,
        "dist/src/runtime.js",
      ),
      importLobsterModule<{ encodeToken: LobsterPackageCompatModules["encodeToken"] }>(
        packageRoot,
        "dist/src/token.js",
      ),
      importLobsterModule<{
        decodeResumeToken: LobsterPackageCompatModules["decodeResumeToken"];
      }>(packageRoot, "dist/src/resume.js"),
      importLobsterModule<{
        runWorkflowFile: LobsterPackageCompatModules["runWorkflowFile"];
      }>(packageRoot, "dist/src/workflows/file.js"),
    ]);

    return createCompatEmbeddedToolRuntime({
      parsePipeline: parserModule.parsePipeline,
      createDefaultRegistry: registryModule.createDefaultRegistry,
      runPipeline: runtimeModule.runPipeline,
      encodeToken: tokenModule.encodeToken,
      decodeResumeToken: resumeModule.decodeResumeToken,
      runWorkflowFile: workflowFileModule.runWorkflowFile,
    });
  } catch (compatError) {
    const cause =
      primaryLoadError === undefined
        ? compatError
        : new AggregateError(
            [primaryLoadError, compatError],
            "Both Lobster embedded runtime load paths failed",
          );
    throw new Error("Failed to load the Lobster embedded runtime", {
      cause,
    });
  }
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: LoadEmbeddedToolRuntime;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(params.timeoutMs, async (signal) => {
        const ctx = createEmbeddedToolContext(params, signal);

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
            return throwOnErrorEnvelope(
              normalizeEnvelope(await runtime.runToolRequest({ filePath, args, ctx })),
            );
          }

          return throwOnErrorEnvelope(
            normalizeEnvelope(await runtime.runToolRequest({ pipeline, ctx })),
          );
        }

        const token = params.token?.trim() ?? "";
        if (!token) {
          throw new Error("token required");
        }
        if (typeof params.approve !== "boolean") {
          throw new Error("approve required");
        }

        return throwOnErrorEnvelope(
          normalizeEnvelope(
            await runtime.resumeToolRequest({
              token,
              approved: params.approve,
              ctx,
            }),
          ),
        );
      });
    },
  };
}
