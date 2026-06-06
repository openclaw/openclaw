// Lobster plugin module implements lobster runner behavior.
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
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

// In-process LLM adapter consumed by the @clawdbot/lobster `llm.invoke` command
// (see its getDirectAdapter / resolveAdapter). invoke({ payload }) receives the
// llm.invoke payload and must return a response envelope of the same shape the
// HTTP `openclaw` provider returns (see invokeOpenClawAdapter), i.e.
// { ok: true, result: { output: { data, text? }, model?, status? } } — but
// produced fully in-process, with NO gateway URL or token. This is the
// "supported embedded bridge" referenced in docs/tools/lobster.md and tracked
// in #76101 / #90909.
export type EmbeddedLlmAdapter = {
  source?: string;
  invoke: (args: {
    env?: Record<string, string | undefined>;
    args?: Record<string, unknown>;
    payload: unknown;
  }) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>;
};

// Host-provided in-process bridges for the embedded runner. Populating these lets
// embedded Lobster workflows run `llm.invoke` (and registry-backed stdlib commands)
// in-process, instead of the HTTP-only `openclaw.invoke` shim that requires
// OPENCLAW_URL + an operator token. No credentials are placed in ctx.env.
export type EmbeddedRuntimeBridges = {
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
  registry?: unknown;
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
    return { runToolRequest, resumeToolRequest };
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
  throw new Error(envelope.error.message);
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

function createEmbeddedToolContext(
  params: LobsterRunnerParams,
  signal?: AbortSignal,
  bridges?: EmbeddedRuntimeBridges,
): EmbeddedToolContext {
  // NOTE: we intentionally do NOT inject OPENCLAW_URL or any gateway token into
  // env. The in-process path runs through bridges.llmAdapters / bridges.registry,
  // so no operator credential is ever exposed to workflow shell steps (#76101).
  const env = { ...process.env } as Record<string, string | undefined>;
  // SECURITY (#76101): actively STRIP gateway credentials that the gateway
  // process env may carry, so they can never reach workflow shell steps via
  // ctx.env. The in-process LLM path needs none of these.
  for (const key of ["OPENCLAW_URL", "OPENCLAW_TOKEN", "CLAWD_URL", "CLAWD_TOKEN"]) {
    delete env[key];
  }
  return {
    cwd: params.cwd,
    env,
    mode: "tool",
    stdin: Readable.from([]),
    stdout: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stdout"),
    stderr: createLimitedSink(Math.max(1024, params.maxStdoutBytes), "stderr"),
    signal,
    ...(bridges?.llmAdapters ? { llmAdapters: bridges.llmAdapters } : {}),
    ...(bridges?.registry !== undefined ? { registry: bridges.registry } : {}),
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
      (error: unknown) => {
        clearTimeout(timer);
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

export async function loadEmbeddedToolRuntimeFromPackage(
  options: LoadEmbeddedToolRuntimeFromPackageOptions = {},
): Promise<EmbeddedToolRuntime> {
  const importModule =
    options.importModule ??
    (async (specifier: string) => (await import(specifier)) as Partial<EmbeddedToolRuntime>);
  const resolvePackageEntry =
    options.resolvePackageEntry ?? ((specifier: string) => lobsterRequire.resolve(specifier));
  const packageEntryPath = resolvePackageEntry("@clawdbot/lobster");
  await installLobsterAjvCompileCache(packageEntryPath);

  let coreLoadError: unknown;
  try {
    const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
    return toEmbeddedToolRuntime(await importModule(coreSpecifier), "@clawdbot/lobster/core");
  } catch (error) {
    coreLoadError = error;
  }

  let fallbackLoadError: unknown;
  try {
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
  bridges?: EmbeddedRuntimeBridges;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  const bridges = options?.bridges;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(params.timeoutMs, async (signal) => {
        const ctx = createEmbeddedToolContext(params, signal, bridges);

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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
