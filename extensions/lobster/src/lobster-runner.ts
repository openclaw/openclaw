import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  extractErrorCode,
  toErrorObject as toLintErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";

type LobsterInputRequest = {
  type?: "input_request";
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  resumeToken?: string;
};

type LobsterEnvelope =
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
      requiresInput?: LobsterInputRequest;
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
  responseJson?: string;
  cancel?: boolean;
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
  requiresInput?: LobsterInputRequest | null;
  error?: {
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

const workflowExts = new Set([".lobster", ".yaml", ".yml", ".json"]);

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
    throw new Error(envelope.error?.message ?? "lobster runtime failed");
  }
  if (envelope.status === "needs_input" && !envelope.requiresInput?.resumeToken) {
    throw new Error("Lobster input request is missing its resume token");
  }
  const normalized: Extract<LobsterEnvelope, { ok: true }> = {
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
    ...(envelope.requiresInput
      ? { requiresInput: { ...envelope.requiresInput, type: "input_request" as const } }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized, null, 2), "utf8") > maxStdoutBytes) {
    throw new Error("lobster runtime result exceeded maxStdoutBytes");
  }
  return normalized;
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
    if (/\s/.test(trimmed) && extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
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
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      const controller = new AbortController();
      return await raceWithTimeout(
        async () => {
          const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);
          const ctx: EmbeddedToolContext = {
            cwd: params.cwd,
            env: { ...process.env },
            mode: "tool",
            stdin: Readable.from([]),
            stdout: createLimitedSink(maxStdoutBytes, "stdout"),
            stderr: createLimitedSink(maxStdoutBytes, "stderr"),
            signal: controller.signal,
          };
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
            const hasApproval = typeof params.approve === "boolean";
            const hasResponse = params.responseJson !== undefined;
            const hasCancel = params.cancel !== undefined;
            if (Number(hasApproval) + Number(hasResponse) + Number(hasCancel) !== 1) {
              throw new Error(
                "resume requires exactly one of approve, responseJson, or cancel: true",
              );
            }
            if (hasCancel && params.cancel !== true) {
              throw new Error("cancel must be true");
            }
            let response: unknown;
            if (params.responseJson !== undefined) {
              try {
                response = JSON.parse(params.responseJson);
              } catch {
                throw new Error("responseJson must be valid JSON");
              }
            }
            envelope = await runtime.resumeToolRequest({
              ...(token ? { token } : {}),
              ...(approvalId ? { approvalId } : {}),
              ...(hasApproval ? { approved: params.approve } : {}),
              ...(hasResponse ? { response } : {}),
              ...(hasCancel ? { cancel: true } : {}),
              ctx,
            });
          }
          return normalizeEnvelope(envelope, maxStdoutBytes);
        },
        Math.max(200, params.timeoutMs),
        () => {
          const error = new Error("lobster runtime timed out");
          controller.abort(error);
          throw error;
        },
      ).catch((error: unknown) => {
        throw toLintErrorObject(error, "Non-Error rejection");
      });
    },
  };
}
