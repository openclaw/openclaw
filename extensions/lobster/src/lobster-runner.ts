// Lobster plugin module implements lobster runner behavior.
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

export type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "needs_input" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
        approvalId?: string;
      };
      requiresInput?: {
        type: "input_request";
        prompt: string;
        responseSchema: unknown;
        defaults?: unknown;
        subject?: unknown;
        resumeToken: string;
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
  response?: unknown;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

export type LobsterRunner = {
  run: (
    params: LobsterRunnerParams,
    hooks?: { beforeResumeIo?: () => void },
  ) => Promise<LobsterEnvelope>;
};

type EmbeddedToolContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
};

type EmbeddedToolEnvelope = {
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    prompt: string;
    items: unknown[];
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: {
    type?: "input_request";
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject?: unknown;
    resumeToken?: string;
  } | null;
  error?: {
    type?: string;
    message: string;
  };
};

export class LobsterRunnerError extends Error {
  readonly type?: string;

  constructor(message: string, type?: string) {
    super(message);
    this.name = "LobsterRunnerError";
    this.type = type;
  }
}

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
    ctx?: EmbeddedToolContext;
  }) => Promise<EmbeddedToolEnvelope>;
};

const workflowExts = new Set([".lobster", ".yaml", ".yml", ".json"]);
const inputRequestModelLimits = {
  prompt: 4 * 1024,
  responseSchema: 8 * 1024,
  defaults: 4 * 1024,
  subject: 2 * 1024,
  resumeToken: 4 * 1024,
  total: 16 * 1024,
} as const;

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

  if (!isPathInside(base, resolved)) {
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

function normalizeEnvelope(
  envelope: EmbeddedToolEnvelope,
  maxStdoutBytes: number,
): Extract<LobsterEnvelope, { ok: true }> {
  if (!envelope.ok) {
    throw new LobsterRunnerError(
      envelope.error?.message ?? "lobster runtime failed",
      envelope.error?.type,
    );
  }
  const status = envelope.status ?? "ok";
  const inputRequest =
    status === "needs_input" ? normalizeInputRequest(envelope.requiresInput) : undefined;
  const normalized: Extract<LobsterEnvelope, { ok: true }> = {
    ok: true,
    status,
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
    ...(inputRequest
      ? {
          requiresInput: {
            type: "input_request",
            prompt: inputRequest.prompt,
            responseSchema: inputRequest.responseSchema,
            ...(inputRequest.defaults !== undefined ? { defaults: inputRequest.defaults } : {}),
            ...(inputRequest.subject !== undefined ? { subject: inputRequest.subject } : {}),
            resumeToken: inputRequest.resumeToken,
          },
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized, null, 2), "utf8") > maxStdoutBytes) {
    throw new Error("lobster runtime result exceeded maxStdoutBytes");
  }
  return normalized;
}

function normalizeInputRequest(
  inputRequest: EmbeddedToolEnvelope["requiresInput"],
): NonNullable<Extract<LobsterEnvelope, { ok: true }>["requiresInput"]> {
  if (
    !inputRequest ||
    inputRequest.type !== "input_request" ||
    typeof inputRequest.prompt !== "string" ||
    inputRequest.responseSchema === undefined ||
    typeof inputRequest.resumeToken !== "string" ||
    !inputRequest.resumeToken
  ) {
    throw new Error("lobster runtime returned an invalid input request");
  }
  const normalized: NonNullable<Extract<LobsterEnvelope, { ok: true }>["requiresInput"]> = {
    type: "input_request",
    prompt: inputRequest.prompt,
    responseSchema: inputRequest.responseSchema,
    ...(inputRequest.defaults !== undefined ? { defaults: inputRequest.defaults } : {}),
    ...(inputRequest.subject !== undefined ? { subject: inputRequest.subject } : {}),
    resumeToken: inputRequest.resumeToken,
  };
  assertInputRequestModelBudget(normalized);
  return normalized;
}

function jsonByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("lobster runtime returned a non-JSON input request");
  }
  if (serialized === undefined) {
    throw new Error("lobster runtime returned a non-JSON input request");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function assertInputRequestFieldBudget(
  field: keyof Omit<typeof inputRequestModelLimits, "total">,
  value: unknown,
): void {
  if (jsonByteLength(value) <= inputRequestModelLimits[field]) {
    return;
  }
  throw new Error(
    `lobster input request ${field} exceeded its model-context limit; shorten that field in the Lobster ask step and retry`,
  );
}

function assertInputRequestModelBudget(
  inputRequest: NonNullable<Extract<LobsterEnvelope, { ok: true }>["requiresInput"]>,
): void {
  assertInputRequestFieldBudget("prompt", inputRequest.prompt);
  assertInputRequestFieldBudget("responseSchema", inputRequest.responseSchema);
  if (inputRequest.defaults !== undefined) {
    assertInputRequestFieldBudget("defaults", inputRequest.defaults);
  }
  if (inputRequest.subject !== undefined) {
    assertInputRequestFieldBudget("subject", inputRequest.subject);
  }
  assertInputRequestFieldBudget("resumeToken", inputRequest.resumeToken);
  if (jsonByteLength(inputRequest) > inputRequestModelLimits.total) {
    throw new Error(
      "lobster input request exceeded its model-context limit; shorten the ask prompt, schema, defaults, or subject and retry",
    );
  }
}

export function assertLobsterResumeDecision(
  params: Pick<LobsterRunnerParams, "approve" | "response">,
): void {
  const hasApprovalDecision = typeof params.approve === "boolean";
  const hasInputResponse = params.response !== undefined;
  if (hasApprovalDecision === hasInputResponse) {
    throw new Error("exactly one of approve or response required");
  }
}

function isMissingPathError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|") || !workflowExts.has(path.extname(trimmed).toLowerCase())) {
    return null;
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  try {
    if (!(await stat(resolved)).isFile()) {
      throw new Error("Workflow path is not a file");
    }
    return resolved;
  } catch (error) {
    if (/\s/.test(trimmed) && isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
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
      (error: unknown) => {
        clearTimeout(timer);
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  // Joined specifier keeps bundlers from statically resolving
  // @clawdbot/lobster/core; the plugin's declared @clawdbot/lobster dependency
  // provides it at runtime, so it is a used direct dependency.
  const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(coreSpecifier)) as EmbeddedToolRuntime;
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: () => Promise<EmbeddedToolRuntime>;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params, hooks) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      return await withTimeout(params.timeoutMs, async (signal) => {
        const ctx = createEmbeddedToolContext(params, signal);
        let envelope: EmbeddedToolEnvelope;

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
                args = JSON.parse(parsedArgsJson) as Record<string, unknown>;
              } catch {
                throw new Error("run --args-json must be valid JSON");
              }
            }
            envelope = await runtime.runToolRequest({ filePath, args, ctx });
          } else {
            envelope = await runtime.runToolRequest({ pipeline, ctx });
          }
        } else {
          const token = params.token?.trim() ?? "";
          const approvalId = params.approvalId?.trim() ?? "";
          if (!token && !approvalId) {
            throw new Error("token or approvalId required");
          }
          assertLobsterResumeDecision(params);
          // The runtime load above may yield while /new or /reset rotates the
          // session. Recheck immediately before Lobster can consume the token.
          hooks?.beforeResumeIo?.();
          envelope = await runtime.resumeToolRequest({
            ...(token ? { token } : {}),
            ...(approvalId ? { approvalId } : {}),
            ...(typeof params.approve === "boolean"
              ? { approved: params.approve }
              : { response: params.response }),
            ctx,
          });
        }
        return normalizeEnvelope(envelope, Math.max(1024, params.maxStdoutBytes));
      });
    },
  };
}
