import { readSessionMessages } from "../../gateway/session-utils.js";
import { shouldLogVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { requestHeartbeatNow as requestHeartbeatNowImpl } from "../../infra/heartbeat-wake.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../../routing/session-key.js";
import { prependBootstrapPromptWarning } from "../bootstrap-budget.js";
import { parseCliOutput, type CliOutput } from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import {
  appendImagePathsToPrompt,
  buildCliSupervisorScopeKey,
  buildCliArgs,
  resolveCliRunQueueKey,
  enqueueCliRun,
  loadPromptRefImages,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./helpers.js";
import {
  cliBackendLog,
  CLI_BACKEND_LOG_OUTPUT_ENV,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
} from "./log.js";
import { injectManagedClaudeCliArgs } from "./managed-claude-cli.js";
import type { PreparedCliRunContext } from "./types.js";

const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,
  enqueueSystemEvent: enqueueSystemEventImpl,
  requestHeartbeatNow: requestHeartbeatNowImpl,
};

export function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
}

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  sessionArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.sessionArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}

export async function executePreparedCliRun(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<CliOutput> {
  const params = context.params;
  const backend = context.preparedBackend.backend;
  const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: cliSessionIdToUse,
  });
  const isManagedMode = backend.sessionMode === "managed";
  const useResume =
    !isManagedMode &&
    Boolean(
      cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
    );
  let systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isManagedMode ? true : isNew,
    systemPrompt: context.systemPrompt,
  });

  // In managed mode, inject conversation history into the system prompt so
  // the CLI backend sees prior turns without owning the session file.
  if (isManagedMode && params.sessionId && params.sessionFile) {
    try {
      const sessionMessages = readSessionMessages(params.sessionId, undefined, params.sessionFile);
      if (sessionMessages.length > 0) {
        const MAX_HISTORY_CHARS = 80_000;
        const historyLines: string[] = [];
        let totalChars = 0;
        for (const msg of (sessionMessages as Array<{ role: string; content: unknown }>).slice(
          -60,
        )) {
          const role =
            msg.role === "assistant" ? "Assistant" : msg.role === "user" ? "User" : "System";
          const textParts = Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
            : typeof msg.content === "string"
              ? [msg.content]
              : [];
          const text = textParts.join("\n").trim();
          if (!text) {
            continue;
          }
          const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n... [truncated]" : text;
          if (totalChars + truncated.length > MAX_HISTORY_CHARS) {
            break;
          }
          historyLines.push(`[${role}]: ${truncated}`);
          totalChars += truncated.length;
        }
        if (historyLines.length > 0) {
          const historyBlock = historyLines.join("\n\n");
          const baseSystem = systemPromptArg ?? context.systemPrompt ?? "";
          systemPromptArg = `${baseSystem}\n\n<conversation_history>\n${historyBlock}\n</conversation_history>\n\nThe above is the conversation history. The user's new message follows as the prompt. Continue the conversation naturally.`;
          cliBackendLog.info(
            `cli managed: injected ${historyLines.length}/${sessionMessages.length} messages (${totalChars} chars) into system prompt`,
          );
        }
      }
    } catch (err) {
      cliBackendLog.warn(`cli managed history injection failed: ${String(err)}`);
    }
  }

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
  let prompt = prependBootstrapPromptWarning(params.prompt, context.bootstrapPromptWarningLines, {
    preserveExactPrompt: context.heartbeatPrompt,
  });
  const resolvedImages =
    params.images && params.images.length > 0
      ? params.images
      : await loadPromptRefImages({ prompt, workspaceDir: context.workspaceDir });
  if (resolvedImages.length > 0) {
    const imagePayload = await writeCliImages(resolvedImages);
    imagePaths = imagePayload.paths;
    cleanupImages = imagePayload.cleanup;
    if (!backend.imageArg) {
      prompt = appendImagePathsToPrompt(prompt, imagePaths);
    }
  }

  const { argsPrompt, stdin } = resolvePromptInput({
    backend,
    prompt,
  });
  const stdinPayload = stdin ?? "";
  const rawBaseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const baseArgs = injectManagedClaudeCliArgs(rawBaseArgs, context.backendResolved.id, backend);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
    : baseArgs;
  const args = buildCliArgs({
    backend,
    baseArgs: resolvedArgs,
    modelId: context.normalizedModel,
    sessionId: resolvedSessionId,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const queueKey = resolveCliRunQueueKey({
    backendId: context.backendResolved.id,
    serialize: backend.serialize,
    runId: params.runId,
    workspaceDir: context.workspaceDir,
    cliSessionId: useResume ? resolvedSessionId : undefined,
  });

  try {
    return await enqueueCliRun(queueKey, async () => {
      cliBackendLog.info(
        `cli exec: provider=${params.provider} model=${context.normalizedModel} promptChars=${params.prompt.length}`,
      );
      const logOutputText =
        isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
        isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
      if (logOutputText) {
        const logArgs = buildCliLogArgs({
          args,
          systemPromptArg: backend.systemPromptArg,
          sessionArg: backend.sessionArg,
          modelArg: backend.modelArg,
          imageArg: backend.imageArg,
          argsPrompt,
        });
        cliBackendLog.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
      }

      const env = (() => {
        const next = sanitizeHostExecEnv({
          baseEnv: process.env,
          overrides: backend.env,
          blockPathOverrides: true,
        });
        for (const key of backend.clearEnv ?? []) {
          delete next[key];
        }
        Object.assign(next, context.preparedBackend.env);
        return next;
      })();
      const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
        backend,
        timeoutMs: params.timeoutMs,
        useResume,
      });
      const supervisor = executeDeps.getProcessSupervisor();
      const scopeKey = buildCliSupervisorScopeKey({
        backend,
        backendId: context.backendResolved.id,
        cliSessionId: useResume ? resolvedSessionId : undefined,
      });

      // Real-time streaming: parse NDJSON lines and emit agent events so
      // typing indicators and delivery pipelines can react immediately.
      const streamedChunks: string[] = [];
      let stdoutBuffer = "";
      const isJsonlMode =
        (useResume ? (backend.resumeOutput ?? backend.output) : backend.output) === "jsonl";
      const onStdoutStream = isJsonlMode
        ? (chunk: string) => {
            stdoutBuffer += chunk;
            const lines = stdoutBuffer.split(/\r?\n/g);
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) {
                continue;
              }
              streamedChunks.push(trimmed);
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed.type === "assistant" && parsed.message?.content) {
                  for (const block of parsed.message.content) {
                    if (block.type === "text" && block.text && params.runId) {
                      emitAgentEvent({
                        runId: params.runId,
                        stream: "assistant",
                        data: { text: block.text },
                      });
                    }
                  }
                }
              } catch {
                // Ignore parse errors for partial lines.
              }
            }
          }
        : undefined;

      const managedRun = await supervisor.spawn({
        sessionId: params.sessionId,
        backendId: context.backendResolved.id,
        scopeKey,
        replaceExistingScope: Boolean(useResume && scopeKey),
        mode: "child",
        argv: [backend.command, ...args],
        timeoutMs: params.timeoutMs,
        noOutputTimeoutMs,
        cwd: context.workspaceDir,
        env,
        input: stdinPayload,
        ...(onStdoutStream ? { captureOutput: false, onStdout: onStdoutStream } : {}),
      });
      const result = await managedRun.wait();

      const stdout = onStdoutStream
        ? [...streamedChunks, stdoutBuffer.trim()].filter(Boolean).join("\n")
        : result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) {
          cliBackendLog.info(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          cliBackendLog.info(`cli stderr:\n${stderr}`);
        }
      }
      if (shouldLogVerbose()) {
        if (stdout) {
          cliBackendLog.debug(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          cliBackendLog.debug(`cli stderr:\n${stderr}`);
        }
      }

      if (result.exitCode !== 0 || result.reason !== "exit") {
        if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
          const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
          cliBackendLog.warn(
            `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
          );
          if (params.sessionKey) {
            const stallNotice = [
              `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
              "It may have been waiting for interactive input or an approval prompt.",
              "For Claude Code, prefer --permission-mode bypassPermissions --print.",
            ].join(" ");
            executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
            executeDeps.requestHeartbeatNow(
              scopedHeartbeatWakeOptions(params.sessionKey, { reason: "cli:watchdog:stall" }),
            );
          }
          throw new FailoverError(timeoutReason, {
            reason: "timeout",
            provider: params.provider,
            model: context.modelId,
            status: resolveFailoverStatus("timeout"),
          });
        }
        if (result.reason === "overall-timeout") {
          const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
          throw new FailoverError(timeoutReason, {
            reason: "timeout",
            provider: params.provider,
            model: context.modelId,
            status: resolveFailoverStatus("timeout"),
          });
        }
        const err = stderr || stdout || "CLI failed.";
        const reason = classifyFailoverReason(err) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(err, {
          reason,
          provider: params.provider,
          model: context.modelId,
          status,
        });
      }

      return parseCliOutput({
        raw: stdout,
        backend,
        providerId: context.backendResolved.id,
        outputMode: useResume ? (backend.resumeOutput ?? backend.output) : backend.output,
        fallbackSessionId: resolvedSessionId,
      });
    });
  } finally {
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}
