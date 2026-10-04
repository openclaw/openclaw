import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  extractErrorCode,
  toErrorObject as toLintErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import {
  deleteCheckpointProvenance,
  readCheckpointProvenance,
  writeCheckpointProvenance,
  type LobsterCheckpointCaller,
  type LobsterCheckpointHandle,
  type LobsterCheckpointProvenance,
  type LobsterLlmStage,
} from "./lobster-checkpoint-provenance.js";

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
  /**
   * The live gateway request's abort signal. Linked into the runner's controller,
   * so Lobster's state-lock waits and resume-state consumption observe request
   * cancellation instead of running to completion after the client is gone.
   */
  signal?: AbortSignal;
};

export type LobsterRunner = {
  run: (params: LobsterRunnerParams) => Promise<LobsterEnvelope>;
};

type EmbeddedLlmAdapter = {
  source?: string;
  invoke: (params: {
    env?: Record<string, string | undefined>;
    args?: Record<string, unknown>;
    payload: unknown;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

type EmbeddedToolContext = {
  registry?: LobsterRegistry;
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
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
  createDefaultRegistry?: () => LobsterRegistry;
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

type LobsterCommand = {
  name: string;
  run: (params: {
    input: AsyncIterable<unknown>;
    args: Record<string, unknown>;
    ctx: { env?: Record<string, string | undefined> } & Record<string, unknown>;
  }) => Promise<{ output?: AsyncIterable<unknown> } & Record<string, unknown>>;
} & Record<string, unknown>;

type LobsterRegistry = {
  get: (name: string) => LobsterCommand | undefined;
  list: () => string[];
};

export type LobsterReplayRequest = { provider: string; command: string };

const LLM_COMMANDS = new Set(["llm.invoke", "llm_task.invoke"]);

/**
 * Whether a stage explicitly chose the embedded route, by its own provider
 * argument or by LOBSTER_LLM_PROVIDER in its FINAL environment (process, then
 * workflow, then step blocks, which Lobster merges before the command runs). The
 * embedded route is opt-in, so it is never inferred from the routes the
 * environment happens to configure.
 */
function embeddedRouteWasRequested(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
): boolean {
  const stepProvider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (stepProvider) {
    return stepProvider === "embedded";
  }
  return (env.LOBSTER_LLM_PROVIDER ?? "").trim().toLowerCase() === "embedded";
}

/**
 * The route label recorded for a non-embedded stage, for provenance and the
 * saved-answer re-authorization request only. Embedded output is the
 * `"embedded"` label, which is set separately; a provider-omitted stage is left
 * for Lobster to resolve, so its label falls back to the adapter source Lobster
 * reported.
 */
function nonEmbeddedRouteLabel(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  items: unknown[],
): string {
  const stepProvider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (stepProvider) {
    return stepProvider;
  }
  const configured = (env.LOBSTER_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (configured) {
    return configured;
  }
  for (const item of items) {
    if (isRecord(item) && typeof item.source === "string" && item.source) {
      return item.source;
    }
  }
  return "external";
}

async function* replayItems(items: unknown[]): AsyncIterable<unknown> {
  yield* items;
}

/** LLM stages that executed during one runner call, and the caller an embedded one spent. */
type LlmStageTrace = { stages: LobsterLlmStage[]; caller?: LobsterCheckpointCaller };

function mergeCaller(
  previous: LobsterCheckpointCaller | undefined,
  current: LobsterCheckpointCaller | undefined,
): LobsterCheckpointCaller | undefined {
  if (!previous || !current) {
    return previous ?? current;
  }
  // The resume was authorized, so both name the same agent; keep the union of
  // authority so a later resume must hold everything either caller spent.
  return {
    ...(previous.agentId ? { agentId: previous.agentId } : {}),
    authority: [...new Set([...previous.authority, ...current.authority])].toSorted(),
  };
}

function nextProvenance(
  previous: LobsterCheckpointProvenance | undefined,
  resumed: boolean,
  trace: LlmStageTrace,
): LobsterCheckpointProvenance {
  const stages = new Map<string, LobsterLlmStage>();
  for (const stage of [...(previous?.stages ?? []), ...trace.stages]) {
    stages.set(`${stage.provider}\u0000${stage.command}`, stage);
  }
  const caller = mergeCaller(previous?.caller, trace.caller);
  return {
    version: 1,
    stages: [...stages.values()],
    ...(caller ? { caller } : {}),
    ...(resumed && (!previous || previous.untrackedOrigin) ? { untrackedOrigin: true } : {}),
  };
}

function checkpointHandle(envelope: EmbeddedToolEnvelope): LobsterCheckpointHandle | undefined {
  if (!envelope.ok) {
    return undefined;
  }
  if (envelope.status === "needs_approval" && envelope.requiresApproval) {
    return {
      token: envelope.requiresApproval.resumeToken,
      approvalId: envelope.requiresApproval.approvalId,
    };
  }
  if (envelope.status === "needs_input" && envelope.requiresInput) {
    return { token: envelope.requiresInput.resumeToken };
  }
  return undefined;
}

/**
 * Wrap Lobster's LLM commands at the one point every stage passes through,
 * inline, workflow and resumed alike, after the stage environment is merged:
 *
 * - Embedded stages spend the caller's own model authority, so their saved
 *   store is hidden entirely: nothing is read from or written to the persistent
 *   cache or run state, and every embedded stage executes under a fresh host
 *   authorization. These are command arguments, which a workflow, a step
 *   environment or a `--refresh false` flag cannot override.
 * - Other routes keep their cache, but a saved answer is shown only after the
 *   caller is re-authorized. A fresh call is not gated here, because the remote
 *   provider applies its own credentials. The direct adapter is hidden from the
 *   runtime for these stages, so Lobster's sole-adapter preference cannot move a
 *   provider-omitted step onto the embedded route: the runtime resolves the
 *   route from the step, then the environment, exactly as it did before the
 *   adapter existed.
 */
function wrapLlmCommands(
  base: LobsterRegistry,
  authorizeReplay: (request: LobsterReplayRequest) => Promise<void>,
  onStage: (stage: LobsterLlmStage) => void,
  beforeStage: () => Promise<void>,
): LobsterRegistry {
  const drain = async (
    result: { output?: AsyncIterable<unknown> } & Record<string, unknown>,
  ): Promise<unknown[]> => {
    const items: unknown[] = [];
    for await (const item of result.output ?? replayItems([])) {
      items.push(item);
    }
    return items;
  };
  const wasReplayed = (items: unknown[]): boolean =>
    items.some((item) => isRecord(item) && item.replayed === true);
  return {
    list: () => base.list(),
    get(name) {
      const command = base.get(name);
      if (!command || !LLM_COMMANDS.has(name)) {
        return command;
      }
      return {
        ...command,
        async run({ input, args, ctx }) {
          await beforeStage();
          const env = ctx.env ?? {};
          if (embeddedRouteWasRequested(args, env)) {
            const result = await command.run({
              input,
              ctx,
              args: {
                ...args,
                provider: "embedded",
                refresh: true,
                "disable-cache": true,
                "state-key": "",
              },
            });
            const items = await drain(result);
            onStage({ provider: "embedded", command: name });
            if (wasReplayed(items)) {
              await authorizeReplay({ provider: "embedded", command: name });
            }
            return { ...result, output: replayItems(items) };
          }
          const result = await command.run({
            input,
            ctx: { ...ctx, llmAdapters: undefined },
            args,
          });
          const items = await drain(result);
          const provider = nonEmbeddedRouteLabel(args, env, items);
          onStage({ provider, command: name });
          if (wasReplayed(items)) {
            await authorizeReplay({ provider, command: name });
          }
          return { ...result, output: replayItems(items) };
        },
      };
    },
  };
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: () => Promise<EmbeddedToolRuntime>;
  llmAdapters?: Record<string, EmbeddedLlmAdapter>;
  /** Re-authorizes the caller before a saved non-embedded answer is shown. Required with llmAdapters. */
  authorizeReplay?: (request: LobsterReplayRequest) => Promise<void>;
  /**
   * Re-authorizes the caller before a resume discloses or consumes what a
   * checkpoint stored. Receives undefined for a checkpoint with no record.
   * Required with llmAdapters.
   */
  authorizeCheckpoint?: (provenance: LobsterCheckpointProvenance | undefined) => Promise<void>;
  /** The current caller's agent and authority, recorded when an embedded stage runs. Required with llmAdapters. */
  describeCaller?: () => LobsterCheckpointCaller;
}): LobsterRunner {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params) {
      runtimePromise ??= loadRuntime();
      const runtime = await runtimePromise;
      let registry: LobsterRegistry | undefined;
      // Re-runs the resumed checkpoint's producer check at each downstream LLM
      // dispatch boundary; undefined for a fresh run.
      let reauthorizeResume: (() => Promise<void>) | undefined;
      let checkpoints:
        | {
            authorize: (provenance: LobsterCheckpointProvenance | undefined) => Promise<void>;
            trace: LlmStageTrace;
          }
        | undefined;
      if (options?.llmAdapters) {
        const { authorizeReplay, authorizeCheckpoint, describeCaller } = options;
        if (
          !runtime.createDefaultRegistry ||
          !authorizeReplay ||
          !authorizeCheckpoint ||
          !describeCaller
        ) {
          throw new Error(
            "lobster embedded route requires the Lobster command registry, a replay authorizer and a checkpoint authorizer",
          );
        }
        const trace: LlmStageTrace = { stages: [] };
        checkpoints = { authorize: authorizeCheckpoint, trace };
        registry = wrapLlmCommands(
          runtime.createDefaultRegistry(),
          authorizeReplay,
          (stage) => {
            trace.stages.push(stage);
            if (stage.provider === "embedded") {
              trace.caller = mergeCaller(trace.caller, describeCaller());
            }
          },
          async () => await reauthorizeResume?.(),
        );
      }
      const controller = new AbortController();
      const externalSignal = params.signal;
      const forwardAbort = () => controller.abort(externalSignal?.reason);
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason);
        } else {
          externalSignal.addEventListener("abort", forwardAbort, { once: true });
        }
      }
      try {
        return await raceWithTimeout(
          async () => {
            const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);
            const ctx: EmbeddedToolContext = {
              cwd: params.cwd,
              env: { ...process.env },
              ...(registry ? { registry } : {}),
              mode: "tool",
              stdin: Readable.from([]),
              stdout: createLimitedSink(maxStdoutBytes, "stdout"),
              stderr: createLimitedSink(maxStdoutBytes, "stderr"),
              signal: controller.signal,
              ...(options?.llmAdapters ? { llmAdapters: options.llmAdapters } : {}),
            };
            let envelope: EmbeddedToolEnvelope;
            let resumed:
              | { handle: LobsterCheckpointHandle; provenance?: LobsterCheckpointProvenance }
              | undefined;

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
              if (token && approvalId && checkpoints) {
                // Lobster's resumeToolRequest gives the approval ID precedence, so a
                // token that names one checkpoint could carry authorization for a
                // different one. Refuse the ambiguous pair rather than authorize the
                // wrong checkpoint.
                throw new Error(
                  "resume accepts either token or approvalId, not both: the approval ID takes precedence, so the two can select different checkpoints",
                );
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
              if (checkpoints && hasCancel) {
                // Cancelling discloses nothing and deletes the stored output.
                resumed = { handle: { token, approvalId } };
              } else if (checkpoints) {
                // Lobster hands a checkpoint's stored stage output to the remaining
                // stages, or back to the caller, without running those stages again, so
                // the LLM command wrapper never sees it. Authorize the caller against
                // what the checkpoint carries before Lobster claims or consumes it; a
                // refusal leaves the checkpoint intact for a caller who may resume it.
                // A rejected approval is gated too: a workflow continues past one.
                const handle = { token, approvalId };
                const provenance = await readCheckpointProvenance(ctx.env ?? {}, handle);
                await checkpoints.authorize(provenance);
                // Armed before Lobster consumes: a later LLM stage re-runs the
                // producer check at its dispatch boundary, so authority revoked while
                // the state lock was held cannot drive a downstream model call.
                reauthorizeResume = async () => await checkpoints.authorize(provenance);
                resumed = { handle, ...(provenance ? { provenance } : {}) };
              }
              // Re-check the live request at the consumption boundary: an await since
              // the authorization may have carried a cancellation, and Lobster's
              // consume is gated by this same signal.
              controller.signal.throwIfAborted();
              envelope = await runtime.resumeToolRequest({
                ...(token ? { token } : {}),
                ...(approvalId ? { approvalId } : {}),
                ...(hasApproval ? { approved: params.approve } : {}),
                ...(hasResponse ? { response } : {}),
                ...(hasCancel ? { cancel: true } : {}),
                ctx,
              });
            }
            if (checkpoints) {
              const next = checkpointHandle(envelope);
              if (next) {
                await writeCheckpointProvenance(
                  ctx.env ?? {},
                  next,
                  nextProvenance(resumed?.provenance, Boolean(resumed), checkpoints.trace),
                );
              }
              if (
                resumed &&
                envelope.ok &&
                (envelope.status === "ok" || envelope.status === "cancelled")
              ) {
                await deleteCheckpointProvenance(ctx.env ?? {}, resumed.handle);
              }
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
      } finally {
        externalSignal?.removeEventListener("abort", forwardAbort);
      }
    },
  };
}
