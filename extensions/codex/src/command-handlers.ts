import crypto from "node:crypto";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import {
  installCodexComputerUse,
  readCodexComputerUseStatus,
  type CodexComputerUseSetupParams,
} from "./app-server/computer-use.js";
import type { CodexComputerUseConfig } from "./app-server/config.js";
import { listAllCodexAppServerModels } from "./app-server/models.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import {
  buildHelp,
  formatAccount,
  formatComputerUseStatus,
  formatCodexStatus,
  formatList,
  formatModels,
  formatThreads,
  readString,
} from "./command-formatters.js";
import {
  codexControlRequest,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
  type SafeValue,
} from "./command-rpc.js";
import {
  readCodexConversationBindingData,
  resolveCodexDefaultWorkspaceDir,
  startCodexConversationThread,
} from "./conversation-binding.js";
import {
  formatPermissionsMode,
  parseCodexFastModeArg,
  parseCodexPermissionsModeArg,
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
} from "./conversation-control.js";

export type CodexCommandDeps = {
  codexControlRequest: CodexControlRequestFn;
  listCodexAppServerModels: typeof listAllCodexAppServerModels;
  readCodexStatusProbes: typeof readCodexStatusProbes;
  readCodexAppServerBinding: typeof readCodexAppServerBinding;
  requestOptions: typeof requestOptions;
  safeCodexControlRequest: SafeCodexControlRequestFn;
  writeCodexAppServerBinding: typeof writeCodexAppServerBinding;
  clearCodexAppServerBinding: typeof clearCodexAppServerBinding;
  readCodexComputerUseStatus: typeof readCodexComputerUseStatus;
  installCodexComputerUse: typeof installCodexComputerUse;
  resolveCodexDefaultWorkspaceDir: typeof resolveCodexDefaultWorkspaceDir;
  startCodexConversationThread: typeof startCodexConversationThread;
  readCodexConversationActiveTurn: typeof readCodexConversationActiveTurn;
  setCodexConversationFastMode: typeof setCodexConversationFastMode;
  setCodexConversationModel: typeof setCodexConversationModel;
  setCodexConversationPermissions: typeof setCodexConversationPermissions;
  steerCodexConversationTurn: typeof steerCodexConversationTurn;
  stopCodexConversationTurn: typeof stopCodexConversationTurn;
};

type CodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
) => Promise<JsonValue | undefined>;

type SafeCodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
) => Promise<SafeValue<JsonValue | undefined>>;

const defaultCodexCommandDeps: CodexCommandDeps = {
  codexControlRequest,
  listCodexAppServerModels: listAllCodexAppServerModels,
  readCodexStatusProbes,
  readCodexAppServerBinding,
  requestOptions,
  safeCodexControlRequest,
  writeCodexAppServerBinding,
  clearCodexAppServerBinding,
  readCodexComputerUseStatus,
  installCodexComputerUse,
  resolveCodexDefaultWorkspaceDir,
  startCodexConversationThread,
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
};

type ParsedBindArgs = {
  threadId?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  help?: boolean;
};

type ParsedComputerUseArgs = {
  action: "status" | "install";
  overrides: Partial<CodexComputerUseConfig>;
  hasOverrides: boolean;
  help?: boolean;
};

type ParsedDiagnosticsArgs =
  | { action: "request"; note: string }
  | { action: "confirm"; token: string }
  | { action: "cancel"; token: string };

type PendingCodexDiagnosticsConfirmation = {
  token: string;
  threadId: string;
  note?: string;
  senderId?: string;
  channel: string;
  createdAt: number;
};

const CODEX_DIAGNOSTICS_SOURCE = "openclaw-diagnostics";
const CODEX_DIAGNOSTICS_REASON_MAX_CHARS = 2048;
const CODEX_DIAGNOSTICS_COOLDOWN_MS = 60_000;
const CODEX_DIAGNOSTICS_ERROR_MAX_CHARS = 500;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS = 5 * 60_000;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS = 100;

const lastCodexDiagnosticsUploadByThread = new Map<string, number>();
const pendingCodexDiagnosticsConfirmations = new Map<string, PendingCodexDiagnosticsConfirmation>();
let lastCodexDiagnosticsUploadAt: number | undefined;

export function resetCodexDiagnosticsFeedbackStateForTests(): void {
  lastCodexDiagnosticsUploadByThread.clear();
  pendingCodexDiagnosticsConfirmations.clear();
  lastCodexDiagnosticsUploadAt = undefined;
}

export async function handleCodexSubcommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> },
): Promise<PluginCommandResult> {
  const deps: CodexCommandDeps = { ...defaultCodexCommandDeps, ...options.deps };
  const [subcommand = "status", ...rest] = splitArgs(ctx.args);
  const normalized = subcommand.toLowerCase();
  if (normalized === "help") {
    return { text: buildHelp() };
  }
  if (normalized === "status") {
    return { text: formatCodexStatus(await deps.readCodexStatusProbes(options.pluginConfig)) };
  }
  if (normalized === "models") {
    return {
      text: formatModels(
        await deps.listCodexAppServerModels(deps.requestOptions(options.pluginConfig, 100)),
      ),
    };
  }
  if (normalized === "threads") {
    return { text: await buildThreads(deps, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "resume") {
    return { text: await resumeThread(deps, ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "bind") {
    return await bindConversation(deps, ctx, options.pluginConfig, rest);
  }
  if (normalized === "detach" || normalized === "unbind") {
    return { text: await detachConversation(deps, ctx) };
  }
  if (normalized === "binding") {
    return { text: await describeConversationBinding(deps, ctx) };
  }
  if (normalized === "stop") {
    return { text: await stopConversationTurn(deps, ctx, options.pluginConfig) };
  }
  if (normalized === "steer") {
    return { text: await steerConversationTurn(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "model") {
    return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "fast") {
    return { text: await setConversationFastMode(deps, ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "permissions") {
    return { text: await setConversationPermissions(deps, ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "compact") {
    return {
      text: await startThreadAction(
        deps,
        ctx,
        options.pluginConfig,
        CODEX_CONTROL_METHODS.compact,
        "compaction",
      ),
    };
  }
  if (normalized === "review") {
    return {
      text: await startThreadAction(
        deps,
        ctx,
        options.pluginConfig,
        CODEX_CONTROL_METHODS.review,
        "review",
      ),
    };
  }
  if (normalized === "diagnostics") {
    return await handleCodexDiagnosticsFeedback(
      deps,
      ctx,
      options.pluginConfig,
      rest.join(" "),
      "/codex diagnostics",
    );
  }
  if (normalized === "computer-use" || normalized === "computeruse") {
    return {
      text: await handleComputerUseCommand(deps, options.pluginConfig, rest),
    };
  }
  if (normalized === "mcp") {
    return {
      text: formatList(
        await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, {
          limit: 100,
        }),
        "MCP servers",
      ),
    };
  }
  if (normalized === "skills") {
    return {
      text: formatList(
        await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}),
        "Codex skills",
      ),
    };
  }
  if (normalized === "account") {
    const [account, limits] = await Promise.all([
      deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.account, {
        refreshToken: false,
      }),
      deps.safeCodexControlRequest(
        options.pluginConfig,
        CODEX_CONTROL_METHODS.rateLimits,
        undefined,
      ),
    ]);
    return { text: formatAccount(account, limits) };
  }
  return { text: `Unknown Codex command: ${subcommand}\n\n${buildHelp()}` };
}

export async function handleCodexDiagnosticsCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> },
): Promise<PluginCommandResult> {
  const deps: CodexCommandDeps = { ...defaultCodexCommandDeps, ...options.deps };
  return await handleCodexDiagnosticsFeedback(
    deps,
    ctx,
    options.pluginConfig,
    ctx.args ?? "",
    "/diagnostics",
  );
}

async function handleComputerUseCommand(
  deps: CodexCommandDeps,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const parsed = parseComputerUseArgs(args);
  if (parsed.help) {
    return [
      "Usage: /codex computer-use [status|install] [--source <marketplace-source>] [--marketplace-path <path>] [--marketplace <name>]",
      "Checks or installs the configured Codex Computer Use plugin through app-server.",
    ].join("\n");
  }
  const params: CodexComputerUseSetupParams = {
    pluginConfig,
    forceEnable: parsed.action === "install" || parsed.hasOverrides,
    ...(Object.keys(parsed.overrides).length > 0 ? { overrides: parsed.overrides } : {}),
  };
  if (parsed.action === "install") {
    return formatComputerUseStatus(await deps.installCodexComputerUse(params));
  }
  return formatComputerUseStatus(await deps.readCodexComputerUseStatus(params));
}

async function bindConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<PluginCommandResult> {
  if (!ctx.sessionFile) {
    return {
      text: "Cannot bind Codex because this command did not include an OpenClaw session file.",
    };
  }
  const parsed = parseBindArgs(args);
  if (parsed.help) {
    return {
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    };
  }
  const workspaceDir = parsed.cwd ?? deps.resolveCodexDefaultWorkspaceDir(pluginConfig);
  const data = await deps.startCodexConversationThread({
    pluginConfig,
    sessionFile: ctx.sessionFile,
    workspaceDir,
    threadId: parsed.threadId,
    model: parsed.model,
    modelProvider: parsed.provider,
  });
  const binding = await deps.readCodexAppServerBinding(ctx.sessionFile);
  const threadId = binding?.threadId ?? parsed.threadId ?? "new thread";
  const summary = `Codex app-server thread ${threadId} in ${workspaceDir}`;
  let request: Awaited<ReturnType<PluginCommandContext["requestConversationBinding"]>>;
  try {
    request = await ctx.requestConversationBinding({
      summary,
      detachHint: "/codex detach",
      data,
    });
  } catch (error) {
    await deps.clearCodexAppServerBinding(ctx.sessionFile);
    throw error;
  }
  if (request.status === "bound") {
    return { text: `Bound this conversation to Codex thread ${threadId} in ${workspaceDir}.` };
  }
  if (request.status === "pending") {
    return request.reply;
  }
  await deps.clearCodexAppServerBinding(ctx.sessionFile);
  return { text: request.message };
}

async function detachConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  const detached = await ctx.detachConversationBinding();
  if (data) {
    await deps.clearCodexAppServerBinding(data.sessionFile);
  } else if (ctx.sessionFile) {
    await deps.clearCodexAppServerBinding(ctx.sessionFile);
  }
  return detached.removed
    ? "Detached this conversation from Codex."
    : "No Codex conversation binding was attached.";
}

async function describeConversationBinding(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  if (!current || !data) {
    return "No Codex conversation binding is attached.";
  }
  const threadBinding = await deps.readCodexAppServerBinding(data.sessionFile);
  const active = deps.readCodexConversationActiveTurn(data.sessionFile);
  return [
    "Codex conversation binding:",
    `- Thread: ${threadBinding?.threadId ?? "unknown"}`,
    `- Workspace: ${data.workspaceDir}`,
    `- Model: ${threadBinding?.model ?? "default"}`,
    `- Fast: ${threadBinding?.serviceTier === "fast" ? "on" : "off"}`,
    `- Permissions: ${threadBinding ? formatPermissionsMode(threadBinding) : "default"}`,
    `- Active run: ${active ? active.turnId : "none"}`,
    `- Session: ${data.sessionFile}`,
  ].join("\n");
}

async function buildThreads(
  deps: CodexCommandDeps,
  pluginConfig: unknown,
  filter: string,
): Promise<string> {
  const response = await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listThreads, {
    limit: 10,
    ...(filter.trim() ? { searchTerm: filter.trim() } : {}),
  });
  return formatThreads(response);
}

async function resumeThread(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  threadId: string | undefined,
): Promise<string> {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
    return "Usage: /codex resume <thread-id>";
  }
  if (!ctx.sessionFile) {
    return "Cannot attach a Codex thread because this command did not include an OpenClaw session file.";
  }
  const response = await deps.codexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.resumeThread,
    {
      threadId: normalizedThreadId,
      persistExtendedHistory: true,
    },
  );
  const thread = isJsonObject(response) && isJsonObject(response.thread) ? response.thread : {};
  const effectiveThreadId = readString(thread, "id") ?? normalizedThreadId;
  await deps.writeCodexAppServerBinding(ctx.sessionFile, {
    threadId: effectiveThreadId,
    cwd: readString(thread, "cwd") ?? "",
    model: isJsonObject(response) ? readString(response, "model") : undefined,
    modelProvider: isJsonObject(response) ? readString(response, "modelProvider") : undefined,
  });
  return `Attached this OpenClaw session to Codex thread ${effectiveThreadId}.`;
}

async function stopConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot stop Codex because this command did not include an OpenClaw session file.";
  }
  return (await deps.stopCodexConversationTurn({ sessionFile, pluginConfig })).message;
}

async function steerConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  message: string,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot steer Codex because this command did not include an OpenClaw session file.";
  }
  return (
    await deps.steerCodexConversationTurn({
      sessionFile,
      pluginConfig,
      message,
    })
  ).message;
}

async function setConversationModel(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  model: string,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex model because this command did not include an OpenClaw session file.";
  }
  const normalized = model.trim();
  if (!normalized) {
    const binding = await deps.readCodexAppServerBinding(sessionFile);
    return binding?.model ? `Codex model: ${binding.model}` : "Usage: /codex model <model>";
  }
  return await deps.setCodexConversationModel({
    sessionFile,
    pluginConfig,
    model: normalized,
  });
}

async function setConversationFastMode(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  value: string | undefined,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex fast mode because this command did not include an OpenClaw session file.";
  }
  const parsed = parseCodexFastModeArg(value);
  if (value && parsed == null && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex fast [on|off|status]";
  }
  return await deps.setCodexConversationFastMode({
    sessionFile,
    pluginConfig,
    enabled: parsed,
  });
}

async function setConversationPermissions(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  value: string | undefined,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex permissions because this command did not include an OpenClaw session file.";
  }
  const parsed = parseCodexPermissionsModeArg(value);
  if (value && !parsed && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  return await deps.setCodexConversationPermissions({
    sessionFile,
    pluginConfig,
    mode: parsed,
  });
}

async function resolveControlSessionFile(ctx: PluginCommandContext): Promise<string | undefined> {
  const binding = await ctx.getCurrentConversationBinding();
  return readCodexConversationBindingData(binding)?.sessionFile ?? ctx.sessionFile;
}

async function handleCodexDiagnosticsFeedback(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string,
  commandPrefix: string,
): Promise<PluginCommandResult> {
  const parsed = parseDiagnosticsArgs(args);
  if (parsed.action === "confirm") {
    return {
      text: await confirmCodexDiagnosticsFeedback(deps, ctx, pluginConfig, parsed.token),
    };
  }
  if (parsed.action === "cancel") {
    return { text: cancelCodexDiagnosticsFeedback(ctx, parsed.token) };
  }
  return await requestCodexDiagnosticsFeedbackApproval(
    deps,
    ctx,
    pluginConfig,
    parsed.note,
    commandPrefix,
  );
}

async function requestCodexDiagnosticsFeedbackApproval(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  note: string,
  commandPrefix: string,
): Promise<PluginCommandResult> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return {
      text: "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.",
    };
  }
  const binding = await deps.readCodexAppServerBinding(sessionFile);
  if (!binding?.threadId) {
    return {
      text: [
        "No Codex thread is attached to this OpenClaw session yet.",
        "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
      ].join("\n"),
    };
  }
  const now = Date.now();
  const cooldownMessage = readCodexDiagnosticsCooldownMessage(binding.threadId, now);
  if (cooldownMessage) {
    return { text: cooldownMessage };
  }
  const reason = normalizeDiagnosticsReason(note);
  const token = createCodexDiagnosticsConfirmation({
    threadId: binding.threadId,
    note: reason,
    senderId: ctx.senderId,
    channel: ctx.channel,
    now,
  });
  const displayThreadId = formatCodexThreadIdForDisplay(binding.threadId);
  const confirmCommand = `${commandPrefix} confirm ${token}`;
  const cancelCommand = `${commandPrefix} cancel ${token}`;
  const lines = [
    "OpenClaw diagnostics found an attached Codex runtime thread.",
    "For the local Gateway support bundle, run: openclaw gateway diagnostics export",
    "Codex diagnostics can send this thread's feedback bundle to OpenAI servers.",
    `Thread: ${displayThreadId}`,
    ...(reason ? [`Note: ${reason}`] : []),
    "Included: Codex logs and spawned Codex subthreads when available.",
    `To send: ${confirmCommand}`,
    `To cancel: ${cancelCommand}`,
    "This request expires in 5 minutes.",
  ];
  return {
    text: lines.join("\n"),
    interactive: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Send diagnostics", value: confirmCommand, style: "danger" },
            { label: "Cancel", value: cancelCommand, style: "secondary" },
          ],
        },
      ],
    },
  };
}

async function confirmCodexDiagnosticsFeedback(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  token: string,
): Promise<string> {
  const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
  if (!pending) {
    return "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.";
  }
  if (pending.senderId && pending.senderId !== ctx.senderId) {
    return "Only the user who requested these Codex diagnostics can confirm the upload.";
  }
  if (pending.channel !== ctx.channel) {
    return "This Codex diagnostics confirmation belongs to a different channel.";
  }
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
  }
  const binding = await deps.readCodexAppServerBinding(sessionFile);
  if (binding?.threadId !== pending.threadId) {
    pendingCodexDiagnosticsConfirmations.delete(token);
    return "The attached Codex thread changed before confirmation. Run /diagnostics again for the current thread.";
  }
  pendingCodexDiagnosticsConfirmations.delete(token);
  return await sendCodexDiagnosticsFeedback(deps, ctx, pluginConfig, pending.note ?? "");
}

function cancelCodexDiagnosticsFeedback(ctx: PluginCommandContext, token: string): string {
  const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
  if (!pending) {
    return "No pending Codex diagnostics confirmation was found.";
  }
  if (pending.senderId && pending.senderId !== ctx.senderId) {
    return "Only the user who requested these Codex diagnostics can cancel the upload.";
  }
  if (pending.channel !== ctx.channel) {
    return "This Codex diagnostics confirmation belongs to a different channel.";
  }
  pendingCodexDiagnosticsConfirmations.delete(token);
  return "Codex diagnostics upload canceled.";
}

async function sendCodexDiagnosticsFeedback(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  note: string,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
  }
  const binding = await deps.readCodexAppServerBinding(sessionFile);
  if (!binding?.threadId) {
    return [
      "No Codex thread is attached to this OpenClaw session yet.",
      "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
    ].join("\n");
  }
  const now = Date.now();
  const cooldownMs = readCodexDiagnosticsCooldownMs(binding.threadId, now);
  if (cooldownMs > 0) {
    return `Codex diagnostics were already sent for this thread recently. Try again in ${Math.ceil(
      cooldownMs / 1000,
    )}s.`;
  }
  const globalCooldownMs = readCodexDiagnosticsGlobalCooldownMs(now);
  if (globalCooldownMs > 0) {
    return `Codex diagnostics were already sent recently. Try again in ${Math.ceil(
      globalCooldownMs / 1000,
    )}s.`;
  }
  const reason = normalizeDiagnosticsReason(note);
  recordCodexDiagnosticsUpload(binding.threadId, now);
  const response = await deps.safeCodexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.feedback,
    {
      classification: "bug",
      threadId: binding.threadId,
      includeLogs: true,
      tags: buildDiagnosticsTags(ctx),
      ...(reason ? { reason } : {}),
    },
  );
  if (!response.ok) {
    const displayThreadId = formatCodexThreadIdForDisplay(binding.threadId);
    return [
      `Could not send Codex diagnostics for thread ${displayThreadId}: ${formatCodexErrorForDisplay(
        response.error,
      )}`,
      `Inspect locally: ${formatCodexResumeCommand(displayThreadId)}`,
    ].join("\n");
  }
  const responseThreadId = isJsonObject(response.value)
    ? readString(response.value, "threadId")
    : undefined;
  const threadId = responseThreadId ?? binding.threadId;
  const displayThreadId = formatCodexThreadIdForDisplay(threadId);
  return [
    `Codex diagnostics sent for thread ${displayThreadId}.`,
    `Inspect locally: ${formatCodexResumeCommand(displayThreadId)}`,
    "Included Codex logs and spawned Codex subthreads when available.",
  ].join("\n");
}

function normalizeDiagnosticsReason(note: string): string | undefined {
  const normalized = normalizeOptionalString(note);
  return normalized ? normalized.slice(0, CODEX_DIAGNOSTICS_REASON_MAX_CHARS) : undefined;
}

function parseDiagnosticsArgs(args: string): ParsedDiagnosticsArgs {
  const [action, token] = splitArgs(args);
  const normalizedAction = action?.toLowerCase();
  if ((normalizedAction === "confirm" || normalizedAction === "--confirm") && token) {
    return { action: "confirm", token };
  }
  if ((normalizedAction === "cancel" || normalizedAction === "--cancel") && token) {
    return { action: "cancel", token };
  }
  return { action: "request", note: args };
}

function createCodexDiagnosticsConfirmation(params: {
  threadId: string;
  note?: string;
  senderId?: string;
  channel: string;
  now: number;
}): string {
  prunePendingCodexDiagnosticsConfirmations(params.now);
  while (pendingCodexDiagnosticsConfirmations.size >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS) {
    const oldestToken = pendingCodexDiagnosticsConfirmations.keys().next().value;
    if (typeof oldestToken !== "string") {
      break;
    }
    pendingCodexDiagnosticsConfirmations.delete(oldestToken);
  }
  const token = crypto.randomBytes(6).toString("hex");
  pendingCodexDiagnosticsConfirmations.set(token, {
    token,
    threadId: params.threadId,
    note: params.note,
    senderId: params.senderId,
    channel: params.channel,
    createdAt: params.now,
  });
  return token;
}

function readPendingCodexDiagnosticsConfirmation(
  token: string,
  now: number,
): PendingCodexDiagnosticsConfirmation | undefined {
  prunePendingCodexDiagnosticsConfirmations(now);
  return pendingCodexDiagnosticsConfirmations.get(token);
}

function prunePendingCodexDiagnosticsConfirmations(now: number): void {
  for (const [token, pending] of pendingCodexDiagnosticsConfirmations) {
    if (now - pending.createdAt >= CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS) {
      pendingCodexDiagnosticsConfirmations.delete(token);
    }
  }
}

function buildDiagnosticsTags(ctx: PluginCommandContext): Record<string, string> {
  const tags: Record<string, string> = {
    source: CODEX_DIAGNOSTICS_SOURCE,
  };
  addTag(tags, "channel", ctx.channel);
  return tags;
}

function addTag(tags: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    tags[key] = value.trim();
  }
}

function formatCodexThreadIdForDisplay(threadId: string): string {
  return formatCodexTextForDisplay(threadId);
}

function formatCodexTextForDisplay(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
  }
  safe = safe.trim();
  return safe || "<unknown>";
}

function readCodexDiagnosticsCooldownMs(threadId: string, now: number): number {
  const lastSentAt = lastCodexDiagnosticsUploadByThread.get(threadId);
  if (!lastSentAt) {
    return 0;
  }
  const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
  if (remainingMs === 0) {
    lastCodexDiagnosticsUploadByThread.delete(threadId);
  }
  return remainingMs;
}

function readCodexDiagnosticsCooldownMessage(threadId: string, now: number): string | undefined {
  const cooldownMs = readCodexDiagnosticsCooldownMs(threadId, now);
  if (cooldownMs > 0) {
    return `Codex diagnostics were already sent for this thread recently. Try again in ${Math.ceil(
      cooldownMs / 1000,
    )}s.`;
  }
  const globalCooldownMs = readCodexDiagnosticsGlobalCooldownMs(now);
  if (globalCooldownMs > 0) {
    return `Codex diagnostics were already sent recently. Try again in ${Math.ceil(
      globalCooldownMs / 1000,
    )}s.`;
  }
  return undefined;
}

function readCodexDiagnosticsGlobalCooldownMs(now: number): number {
  if (lastCodexDiagnosticsUploadAt == null) {
    return 0;
  }
  const remainingMs = Math.max(
    0,
    CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastCodexDiagnosticsUploadAt),
  );
  if (remainingMs === 0) {
    lastCodexDiagnosticsUploadAt = undefined;
  }
  return remainingMs;
}

function recordCodexDiagnosticsUpload(threadId: string, now: number): void {
  pruneCodexDiagnosticsCooldowns(now);
  lastCodexDiagnosticsUploadAt = now;
  if (!lastCodexDiagnosticsUploadByThread.has(threadId)) {
    while (lastCodexDiagnosticsUploadByThread.size >= CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS) {
      const oldestThreadId = lastCodexDiagnosticsUploadByThread.keys().next().value;
      if (typeof oldestThreadId !== "string") {
        break;
      }
      lastCodexDiagnosticsUploadByThread.delete(oldestThreadId);
    }
  }
  lastCodexDiagnosticsUploadByThread.set(threadId, now);
}

function pruneCodexDiagnosticsCooldowns(now: number): void {
  for (const [threadId, lastSentAt] of lastCodexDiagnosticsUploadByThread) {
    if (now - lastSentAt >= CODEX_DIAGNOSTICS_COOLDOWN_MS) {
      lastCodexDiagnosticsUploadByThread.delete(threadId);
    }
  }
}

function formatCodexErrorForDisplay(error: string): string {
  const safe = formatCodexTextForDisplay(error).slice(0, CODEX_DIAGNOSTICS_ERROR_MAX_CHARS);
  return safe || "unknown error";
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    codePoint < 32 ||
    codePoint === 127 ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

function formatCodexResumeCommand(threadId: string): string {
  return `codex resume ${shellSingleQuote(threadId)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function startThreadAction(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  method: typeof CODEX_CONTROL_METHODS.compact | typeof CODEX_CONTROL_METHODS.review,
  label: string,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return `Cannot start Codex ${label} because this command did not include an OpenClaw session file.`;
  }
  const binding = await deps.readCodexAppServerBinding(sessionFile);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  if (method === CODEX_CONTROL_METHODS.review) {
    await deps.codexControlRequest(pluginConfig, method, {
      threadId: binding.threadId,
      target: { type: "uncommittedChanges" },
    });
  } else {
    await deps.codexControlRequest(pluginConfig, method, { threadId: binding.threadId });
  }
  return `Started Codex ${label} for thread ${binding.threadId}.`;
}

function splitArgs(value: string | undefined): string[] {
  return (value ?? "").trim().split(/\s+/).filter(Boolean);
}

function parseBindArgs(args: string[]): ParsedBindArgs {
  const parsed: ParsedBindArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--cwd") {
      parsed.cwd = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--model") {
      parsed.model = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--provider" || arg === "--model-provider") {
      parsed.provider = args[index + 1];
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && !parsed.threadId) {
      parsed.threadId = arg;
      continue;
    }
    parsed.help = true;
  }
  parsed.threadId = normalizeOptionalString(parsed.threadId);
  parsed.cwd = normalizeOptionalString(parsed.cwd);
  parsed.model = normalizeOptionalString(parsed.model);
  parsed.provider = normalizeOptionalString(parsed.provider);
  return parsed;
}

function parseComputerUseArgs(args: string[]): ParsedComputerUseArgs {
  const parsed: ParsedComputerUseArgs = {
    action: "status",
    overrides: {},
    hasOverrides: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "status" || arg === "install") {
      parsed.action = arg;
      continue;
    }
    if (arg === "--source" || arg === "--marketplace-source") {
      const value = readRequiredOptionValue(args, index);
      if (!value) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplaceSource = value;
      index += 1;
      continue;
    }
    if (arg === "--marketplace-path" || arg === "--path") {
      const value = readRequiredOptionValue(args, index);
      if (!value) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplacePath = value;
      index += 1;
      continue;
    }
    if (arg === "--marketplace") {
      const value = readRequiredOptionValue(args, index);
      if (!value) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplaceName = value;
      index += 1;
      continue;
    }
    if (arg === "--plugin") {
      const value = readRequiredOptionValue(args, index);
      if (!value) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.pluginName = value;
      index += 1;
      continue;
    }
    if (arg === "--server" || arg === "--mcp-server") {
      const value = readRequiredOptionValue(args, index);
      if (!value) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.mcpServerName = value;
      index += 1;
      continue;
    }
    parsed.help = true;
  }
  parsed.overrides = normalizeComputerUseStringOverrides(parsed.overrides);
  parsed.hasOverrides = Object.values(parsed.overrides).some(Boolean);
  return parsed;
}

function readRequiredOptionValue(args: string[], index: number): string | undefined {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    return undefined;
  }
  return value;
}

function normalizeComputerUseStringOverrides(
  overrides: Partial<CodexComputerUseConfig>,
): Partial<CodexComputerUseConfig> {
  const normalized: Partial<CodexComputerUseConfig> = {};
  const marketplaceSource = normalizeOptionalString(overrides.marketplaceSource);
  if (marketplaceSource) {
    normalized.marketplaceSource = marketplaceSource;
  }
  const marketplacePath = normalizeOptionalString(overrides.marketplacePath);
  if (marketplacePath) {
    normalized.marketplacePath = marketplacePath;
  }
  const marketplaceName = normalizeOptionalString(overrides.marketplaceName);
  if (marketplaceName) {
    normalized.marketplaceName = marketplaceName;
  }
  const pluginName = normalizeOptionalString(overrides.pluginName);
  if (pluginName) {
    normalized.pluginName = pluginName;
  }
  const mcpServerName = normalizeOptionalString(overrides.mcpServerName);
  if (mcpServerName) {
    normalized.mcpServerName = mcpServerName;
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
