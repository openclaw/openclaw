import fs from "node:fs/promises";
import path from "node:path";
import type { CliOutput } from "../../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { buildClaudeTmuxArgs } from "./args.js";
import { parseHookEventLine, writeActiveRun, writeClaudeTmuxRuntimeFiles } from "./hooks.js";
import { TmuxSessionManager } from "./manager.js";
import { resolveTmuxRuntimePaths, ensureTmuxRuntimeDir } from "./runtime-dir.js";
import { buildTmuxSessionName, sha256Hex } from "./session-name.js";
import { TerminalDeltaTracker } from "./terminal-stream.js";
import type {
  NormalizedTmuxConfig,
  TmuxActiveRun,
  TmuxExecutionInput,
  TmuxHookEvent,
  TmuxMetadata,
} from "./types.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_IDLE_MS = 1_200;
const DEFAULT_CAPTURE_LINES = 160;
const CLAUDE_READY_RE = /\bClaude Code v\d+\.\d+\.\d+\b/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTmuxConfig(input: TmuxExecutionInput): NormalizedTmuxConfig {
  const config =
    input.backend.execution?.mode === "tmux" ? input.backend.execution.tmux : undefined;
  return {
    sessionNamePrefix: config?.sessionNamePrefix ?? "openclaw-claude",
    runtimeDir: config?.runtimeDir,
    startupTimeoutMs: config?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    turnTimeoutMs: config?.turnTimeoutMs ?? input.timeoutMs,
    turnIdleMs: config?.turnIdleMs ?? DEFAULT_TURN_IDLE_MS,
    captureLines: config?.captureLines ?? DEFAULT_CAPTURE_LINES,
    stopOnAbort: config?.stopOnAbort ?? true,
    memoryMode: config?.memoryMode ?? "managed-disabled",
    hookMode: config?.hookMode ?? "managed",
    authMode: config?.authMode ?? "openclaw",
  };
}

async function readFromOffset(
  filePath: string,
  offset: number,
): Promise<{ text: string; offset: number }> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (stat.size <= offset) {
        return { text: "", offset: stat.size };
      }
      const buffer = Buffer.alloc(stat.size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      return { text: buffer.toString("utf8"), offset: stat.size };
    } finally {
      await handle.close();
    }
  } catch {
    return { text: "", offset };
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function readTextTail(filePath: string, maxBytes = 32_768): Promise<string> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      if (length <= 0) {
        return "";
      }
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function looksLikeTrustPrompt(text: string): boolean {
  return (
    text.includes("Quick safety check") &&
    text.includes("Yes, I trust this folder") &&
    text.includes("Enter to confirm")
  );
}

function looksReadyForPrompt(text: string): boolean {
  return CLAUDE_READY_RE.test(text);
}

async function waitForStartup(params: {
  manager: TmuxSessionManager;
  sessionName: string;
  paths: ReturnType<typeof resolveTmuxRuntimePaths>;
  config: NormalizedTmuxConfig;
  startedAt: number;
  input: TmuxExecutionInput;
}): Promise<void> {
  const deadline = params.startedAt + params.config.startupTimeoutMs;
  let confirmedTrustPrompt = false;
  while (Date.now() <= deadline) {
    if (params.input.abortSignal?.aborted) {
      if (params.config.stopOnAbort) {
        await params.manager.interrupt(params.sessionName);
      }
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    const logTail = await readTextTail(params.paths.paneLogFile);
    const captureTail = await params.manager.captureTail(
      params.sessionName,
      params.config.captureLines,
    );
    const combinedTail = `${logTail}\n${captureTail}`;
    if (looksLikeTrustPrompt(combinedTail) && !confirmedTrustPrompt) {
      await params.manager.sendEnter(params.sessionName);
      confirmedTrustPrompt = true;
      await sleep(100);
      continue;
    }
    if (looksReadyForPrompt(combinedTail)) {
      return;
    }
    const eventTail = await readTextTail(params.paths.eventsFile);
    for (const line of eventTail.split("\n")) {
      const event = parseHookEventLine(line);
      if (event?.event === "SessionStart" && event.timestamp >= params.startedAt) {
        return;
      }
    }
    await sleep(100);
  }
  const tail = await params.manager.captureTail(params.sessionName, params.config.captureLines);
  throw new FailoverError(
    `CLI tmux session did not become ready within ${Math.round(params.config.startupTimeoutMs / 1000)}s.${tail ? `\n\nPane tail:\n${tail}` : ""}`,
    {
      reason: "timeout",
      provider: params.input.backendId,
      model: params.input.modelId,
      status: resolveFailoverStatus("timeout"),
    },
  );
}

function pickToolName(stdin: Record<string, unknown> | undefined): string {
  return (
    (typeof stdin?.tool_name === "string" && stdin.tool_name.trim()) ||
    (typeof stdin?.toolName === "string" && stdin.toolName.trim()) ||
    "tool"
  );
}

function pickToolUseId(stdin: Record<string, unknown> | undefined): string | undefined {
  const candidates = [stdin?.tool_use_id, stdin?.toolUseId, stdin?.id];
  return candidates.find(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function stringifyHookPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable hook payload]";
  }
}

function dispatchHookEvent(input: TmuxExecutionInput, event: TmuxHookEvent): void {
  const stdin = event.stdin;
  if (event.event === "SessionStart") {
    input.onSystemInit?.({ subtype: "init", sessionId: event.claudeSessionId });
    return;
  }
  if (event.event === "PreToolUse") {
    input.onToolUseEvent?.({
      name: pickToolName(stdin),
      toolUseId: pickToolUseId(stdin),
      input: stdin?.tool_input ?? stdin?.toolInput,
    });
    return;
  }
  if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
    input.onToolResult?.({
      toolUseId: pickToolUseId(stdin),
      text: stringifyHookPayload(stdin?.tool_response ?? stdin?.toolResponse),
      isError: event.event === "PostToolUseFailure",
    });
  }
}

function buildMetadata(params: {
  input: TmuxExecutionInput;
  config: NormalizedTmuxConfig;
  sessionName: string;
  systemPromptHash: string;
  launchHash: string;
}): TmuxMetadata {
  const now = Date.now();
  return {
    backendId: params.input.backendId,
    workspaceDir: params.input.workspaceDir,
    sessionName: params.sessionName,
    launchHash: params.launchHash,
    model: params.input.modelId,
    systemPromptHash: params.systemPromptHash,
    ...(params.input.mcpConfigHash ? { mcpConfigHash: params.input.mcpConfigHash } : {}),
    ...(params.input.authProfileId ? { authProfileId: params.input.authProfileId } : {}),
    memoryMode: params.config.memoryMode,
    hookMode: params.config.hookMode,
    createdAt: now,
    lastUsedAt: now,
  };
}

export async function executeTmuxCliRun(
  input: TmuxExecutionInput,
  manager = new TmuxSessionManager(),
): Promise<CliOutput> {
  const config = normalizeTmuxConfig(input);
  if (config.memoryMode === "bare") {
    throw new FailoverError(
      "Claude tmux mode does not support --bare; use managed-disabled memory.",
      {
        reason: "unknown",
        provider: input.backendId,
        model: input.modelId,
        status: resolveFailoverStatus("unknown"),
      },
    );
  }
  const systemPromptHash = sha256Hex(input.systemPrompt);
  const sessionName = buildTmuxSessionName({
    prefix: config.sessionNamePrefix,
    backendId: input.backendId,
    workspaceDir: input.workspaceDir,
    sessionKey: input.sessionId,
    modelId: input.modelId,
    systemPromptHash,
    mcpConfigHash: input.mcpConfigHash,
    authProfileId: input.authProfileId,
    memoryMode: config.memoryMode,
    hookMode: config.hookMode,
  });
  const paths = resolveTmuxRuntimePaths({ runtimeDir: config.runtimeDir, sessionName });
  await ensureTmuxRuntimeDir(paths);
  const { managedSettingsJson } = await writeClaudeTmuxRuntimeFiles({
    paths,
    systemPrompt: input.systemPrompt,
    hookMode: config.hookMode,
  });

  const args = buildClaudeTmuxArgs({
    backend: input.backend,
    baseArgs: input.backend.args,
    modelId: input.modelId,
    settingsFile: paths.settingsFile,
    managedSettingsJson,
    systemPromptFile: paths.systemPromptFile,
    sessionId: input.cliSessionId,
  });
  const env = {
    ...input.env,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...(config.authMode === "openclaw"
      ? { CLAUDE_CONFIG_DIR: path.join(paths.rootDir, "claude-config") }
      : {}),
  };
  if (config.authMode === "openclaw" && env.CLAUDE_CONFIG_DIR) {
    await fs.mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const launchHash = sha256Hex(
    input.backend.command,
    JSON.stringify(args),
    stableJson(env),
    managedSettingsJson,
    input.systemPrompt,
  );
  const metadata = buildMetadata({ input, config, sessionName, systemPromptHash, launchHash });
  const sessionState = await manager.ensureSession({
    paths,
    metadata,
    command: input.backend.command,
    args,
    cwd: input.workspaceDir,
    env,
    config,
  });
  if (!sessionState || sessionState.created) {
    await waitForStartup({
      manager,
      sessionName,
      paths,
      config,
      startedAt: Date.now(),
      input,
    });
  }

  const startedAt = Date.now();
  const activeRun: TmuxActiveRun = {
    runId: input.runId,
    openclawSessionId: input.sessionId,
    ...(input.cliSessionId ? { cliSessionId: input.cliSessionId } : {}),
    startedAt,
    promptHash: sha256Hex(input.prompt),
    turnIndex: startedAt,
  };
  const initialPaneOffset = await fileSize(paths.paneLogFile);
  const initialEventOffset = await fileSize(paths.eventsFile);
  await writeActiveRun(paths, activeRun);
  await fs.writeFile(
    paths.promptBufferFile,
    input.prompt.endsWith("\n") ? input.prompt : `${input.prompt}\n`,
    {
      mode: 0o600,
    },
  );
  await manager.pastePrompt({
    sessionName,
    bufferName: `openclaw-${input.runId.slice(0, 12)}`,
    promptFile: paths.promptBufferFile,
  });

  const terminal = new TerminalDeltaTracker();
  let paneOffset = initialPaneOffset;
  let eventOffset = initialEventOffset;
  let pendingPromptEcho = input.prompt.endsWith("\n") ? input.prompt : `${input.prompt}\n`;
  let sawStop = false;
  let sawCurrentRunHook = false;
  let cliSessionId = input.cliSessionId;
  let lastActivityAt = Date.now();
  const deadline = Date.now() + Math.min(input.timeoutMs, config.turnTimeoutMs);

  while (!sawStop) {
    if (input.abortSignal?.aborted) {
      if (config.stopOnAbort) {
        await manager.interrupt(sessionName);
      }
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }

    const pane = await readFromOffset(paths.paneLogFile, paneOffset);
    paneOffset = pane.offset;
    if (pane.text) {
      lastActivityAt = Date.now();
      const paneText = (() => {
        const rawText = pane.text.replaceAll("\r", "");
        if (!pendingPromptEcho) {
          return rawText;
        }
        if (pendingPromptEcho.startsWith(rawText)) {
          pendingPromptEcho = pendingPromptEcho.slice(rawText.length);
          return "";
        }
        if (rawText.startsWith(pendingPromptEcho)) {
          const stripped = rawText.slice(pendingPromptEcho.length);
          pendingPromptEcho = "";
          return stripped;
        }
        const promptIndex = rawText.indexOf(pendingPromptEcho);
        if (promptIndex >= 0) {
          const lineStart = rawText.lastIndexOf("\n", Math.max(0, promptIndex - 1)) + 1;
          const afterPromptIndex = promptIndex + pendingPromptEcho.length;
          const afterEchoIndex =
            rawText[afterPromptIndex] === "\n" ? afterPromptIndex + 1 : afterPromptIndex;
          const stripped = rawText.slice(0, lineStart) + rawText.slice(afterEchoIndex);
          pendingPromptEcho = "";
          return stripped;
        }
        pendingPromptEcho = "";
        return rawText;
      })();
      const delta = terminal.push(paneText);
      if (delta) {
        input.onAssistantTurn?.(delta);
      }
    }

    const events = await readFromOffset(paths.eventsFile, eventOffset);
    eventOffset = events.offset;
    if (events.text) {
      lastActivityAt = Date.now();
      for (const line of events.text.split("\n")) {
        const event = parseHookEventLine(line);
        if (!event || event.runId !== input.runId || event.timestamp < startedAt) {
          continue;
        }
        sawCurrentRunHook = true;
        if (event.claudeSessionId) {
          cliSessionId = event.claudeSessionId;
        }
        dispatchHookEvent(input, event);
        if (event.event === "Stop") {
          sawStop = true;
        }
      }
    }

    if (sawStop) {
      break;
    }
    if (Date.now() > deadline) {
      const tail = await manager.captureTail(sessionName, config.captureLines);
      throw new FailoverError(
        `CLI exceeded timeout (${Math.round(input.timeoutMs / 1000)}s) in tmux session.${tail ? `\n\nPane tail:\n${tail}` : ""}`,
        {
          reason: "timeout",
          provider: input.backendId,
          model: input.modelId,
          status: resolveFailoverStatus("timeout"),
        },
      );
    }
    if (
      (config.hookMode === "off" || !sawCurrentRunHook) &&
      terminal.getText() &&
      Date.now() - lastActivityAt >= config.turnIdleMs
    ) {
      break;
    }
    await sleep(100);
  }

  return {
    text: terminal.getText(),
    ...((cliSessionId ?? input.cliSessionId)
      ? { sessionId: cliSessionId ?? input.cliSessionId }
      : {}),
  };
}
