import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  isCodexFastServiceTier,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./app-server/config.js";
import type { CodexServiceTier, CodexThreadResumeResponse } from "./app-server/protocol.js";
import {
  readCodexAppServerConversationReasoningDefaults,
  resolveCodexAppServerConversationReasoningEffort,
  resolveCodexAppServerReasoningMode,
  setCodexAppServerConversationReasoningDefault,
  type CodexAppServerReasoningMode,
} from "./app-server/reasoning-defaults.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerCollaborationMode,
  type CodexAppServerConversationReasoningDefaults,
  type CodexAppServerReasoningEffort,
} from "./app-server/session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { formatCodexDisplayText } from "./command-formatters.js";

type ActiveTurn = {
  sessionFile: string;
  threadId: string;
  turnId: string;
};

type CodexAppServerBindingLookup = NonNullable<Parameters<typeof readCodexAppServerBinding>[1]>;

type PermissionsMode = "default" | "yolo";
type PlanMode = "default" | "plan";
export type ParsedCodexReasoningEffortArg = {
  mode?: CodexAppServerReasoningMode;
  effort?: CodexAppServerReasoningEffort | "default";
  status: boolean;
};

const CODEX_CONVERSATION_CONTROL_STATE = Symbol.for("openclaw.codex.conversationControl");

function getActiveTurns(): Map<string, ActiveTurn> {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_CONVERSATION_CONTROL_STATE]?: Map<string, ActiveTurn>;
  };
  globalState[CODEX_CONVERSATION_CONTROL_STATE] ??= new Map();
  return globalState[CODEX_CONVERSATION_CONTROL_STATE];
}

export function trackCodexConversationActiveTurn(active: ActiveTurn): () => void {
  const activeTurns = getActiveTurns();
  activeTurns.set(active.sessionFile, active);
  return () => {
    const current = activeTurns.get(active.sessionFile);
    if (current?.turnId === active.turnId) {
      activeTurns.delete(active.sessionFile);
    }
  };
}

export function readCodexConversationActiveTurn(sessionFile: string): ActiveTurn | undefined {
  return getActiveTurns().get(sessionFile);
}

export async function stopCodexConversationTurn(params: {
  sessionFile: string;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<{ stopped: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.sessionFile);
  if (!active) {
    return { stopped: false, message: "No active Codex run to stop." };
  }
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const lookup = buildBindingLookup(params);
  const binding = await readCodexAppServerBinding(params.sessionFile, lookup);
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding?.authProfileId,
    ...lookup,
  });
  try {
    await client.request(
      "turn/interrupt",
      {
        threadId: active.threadId,
        turnId: active.turnId,
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
  } finally {
    releaseLeasedSharedCodexAppServerClient(client);
  }
  return { stopped: true, message: "Codex stop requested." };
}

export async function steerCodexConversationTurn(params: {
  sessionFile: string;
  message: string;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<{ steered: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.sessionFile);
  const text = params.message.trim();
  if (!text) {
    return { steered: false, message: "Usage: /codex steer <message>" };
  }
  if (!active) {
    return { steered: false, message: "No active Codex run to steer." };
  }
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const lookup = buildBindingLookup(params);
  const binding = await readCodexAppServerBinding(params.sessionFile, lookup);
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding?.authProfileId,
    ...lookup,
  });
  try {
    await client.request(
      "turn/steer",
      {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: [{ type: "text", text, text_elements: [] }],
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
  } finally {
    releaseLeasedSharedCodexAppServerClient(client);
  }
  return { steered: true, message: "Sent steer message to Codex." };
}

export async function setCodexConversationModel(params: {
  sessionFile: string;
  model: string;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const model = params.model.trim();
  if (!model) {
    return "Usage: /codex model <model>";
  }
  const lookup = buildBindingLookup(params);
  const binding = await requireThreadBinding(params.sessionFile, lookup);
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const response = await resumeThreadWithOverrides({
    pluginConfig: params.pluginConfig,
    threadId: binding.threadId,
    authProfileId: binding.authProfileId,
    ...lookup,
    model,
  });
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      ...binding,
      cwd: response.thread.cwd ?? binding.cwd,
      model: response.model ?? model,
      modelProvider: response.modelProvider ?? binding.modelProvider,
      collaborationMode: binding.collaborationMode,
      reasoningEffort: binding.reasoningEffort,
      reasoningEffortDefaults: binding.reasoningEffortDefaults,
      approvalPolicy: binding.approvalPolicy,
      sandbox: binding.sandbox,
      serviceTier: binding.serviceTier ?? runtime.serviceTier,
    },
    lookup,
  );
  return `Codex model set to ${formatCodexDisplayText(response.model ?? model)}.`;
}

export async function setCodexConversationFastMode(params: {
  sessionFile: string;
  enabled?: boolean;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const lookup = buildBindingLookup(params);
  const binding = await requireThreadBinding(params.sessionFile, lookup);
  if (params.enabled == null) {
    return `Codex fast mode: ${isCodexFastServiceTier(binding.serviceTier) ? "on" : "off"}.`;
  }
  const serviceTier: CodexServiceTier = params.enabled ? "priority" : "flex";
  // Fast mode is sent on each later turn; do not require Codex to accept an
  // immediate thread/resume control request just to persist the preference.
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      ...binding,
      serviceTier,
    },
    lookup,
  );
  return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
}

export async function setCodexConversationPermissions(params: {
  sessionFile: string;
  mode?: PermissionsMode;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const lookup = buildBindingLookup(params);
  const binding = await requireThreadBinding(params.sessionFile, lookup);
  if (!params.mode) {
    return `Codex permissions: ${formatPermissionsMode(binding)}.`;
  }
  const policy = permissionsForMode(params.mode);
  // Native bound turns pass these settings at turn/start time, so this command
  // can update the local binding even when app-server resume overrides fail.
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      ...binding,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    },
    lookup,
  );
  return `Codex permissions set to ${params.mode === "yolo" ? "full access" : "default"}.`;
}

export async function setCodexConversationPlanMode(params: {
  sessionFile: string;
  mode?: PlanMode;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const lookup = buildBindingLookup(params);
  const binding = await requireThreadBinding(params.sessionFile, lookup);
  if (!params.mode) {
    return `Codex plan mode: ${formatPlanMode(binding.collaborationMode)}. ${formatCurrentReasoningEffortStatus(
      binding,
      params.pluginConfig,
    )}`;
  }
  const collaborationMode = params.mode === "plan" ? "plan" : "default";
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      ...binding,
      collaborationMode,
    },
    lookup,
  );
  return `Codex plan mode ${params.mode === "plan" ? "enabled" : "disabled"}. ${formatCurrentReasoningEffortStatus(
    { ...binding, collaborationMode },
    params.pluginConfig,
  )}`;
}

export async function setCodexConversationReasoningEffort(params: {
  sessionFile: string;
  parsed?: ParsedCodexReasoningEffortArg;
  effort?: CodexAppServerReasoningEffort | "default";
  mode?: CodexAppServerReasoningMode;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const lookup = buildBindingLookup(params);
  const binding = await requireThreadBinding(params.sessionFile, lookup);
  const command = params.parsed ?? {
    effort: params.effort,
    mode: params.mode,
    status: !params.effort,
  };
  if (command.status || !command.effort) {
    return formatReasoningEffortStatus(binding, params.pluginConfig);
  }
  const mode = command.mode ?? resolveCodexAppServerReasoningMode(binding.collaborationMode);
  const reasoningEffortDefaults = setCodexAppServerConversationReasoningDefault(
    binding.reasoningEffortDefaults,
    mode,
    command.effort === "default" ? undefined : command.effort,
  );
  await writeCodexAppServerBinding(
    params.sessionFile,
    {
      ...binding,
      reasoningEffort: undefined,
      reasoningEffortDefaults,
    },
    lookup,
  );
  return command.effort === "default"
    ? `Codex ${formatReasoningMode(mode)} think reset to default.`
    : `Codex ${formatReasoningMode(mode)} think set to ${command.effort}.`;
}

export function parseCodexFastModeArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return undefined;
  }
  if (normalized === "on" || normalized === "true" || normalized === "fast") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "flex") {
    return false;
  }
  return undefined;
}

export function parseCodexPermissionsModeArg(arg: string | undefined): PermissionsMode | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return undefined;
  }
  if (normalized === "yolo" || normalized === "full" || normalized === "full-access") {
    return "yolo";
  }
  if (normalized === "default" || normalized === "guardian") {
    return "default";
  }
  return undefined;
}

export function parseCodexPlanModeArg(arg: string | undefined): PlanMode | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return undefined;
  }
  if (normalized === "on" || normalized === "true" || normalized === "plan") {
    return "plan";
  }
  if (normalized === "off" || normalized === "false" || normalized === "default") {
    return "default";
  }
  return undefined;
}

export function parseCodexReasoningEffortArg(
  args: string | undefined | readonly string[],
): ParsedCodexReasoningEffortArg | undefined {
  const values = (Array.isArray(args) ? [...args] : args === undefined ? [] : [args])
    .map((arg) => arg.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || (values.length === 1 && values[0] === "status")) {
    return { status: true };
  }
  if (values.length > 2) {
    return undefined;
  }
  const mode = parseReasoningMode(values[0]);
  if (!mode && values.length > 1) {
    return undefined;
  }
  const value = mode ? values[1] : values[0];
  if (!value || value === "status") {
    return mode && values.length === 2 ? { mode, status: true } : undefined;
  }
  const effort = parseReasoningEffort(value);
  if (!effort) {
    return undefined;
  }
  return { ...(mode ? { mode } : {}), effort, status: false };
}

export function formatPermissionsMode(binding: {
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
}): string {
  return binding.approvalPolicy === "never" && binding.sandbox === "danger-full-access"
    ? "full access"
    : "default";
}

export function formatPlanMode(mode: CodexAppServerCollaborationMode | undefined): string {
  return mode === "plan" ? "on" : "off";
}

export function formatReasoningEffort(effort: CodexAppServerReasoningEffort | undefined): string {
  return effort ?? "default";
}

function parseReasoningMode(value: string | undefined): CodexAppServerReasoningMode | undefined {
  if (value === "plan") {
    return "plan";
  }
  return value === "execute" || value === "execution" ? "execute" : undefined;
}

function parseReasoningEffort(
  value: string,
): CodexAppServerReasoningEffort | "default" | undefined {
  if (
    value === "default" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

function formatReasoningMode(mode: CodexAppServerReasoningMode): string {
  return mode === "plan" ? "plan-mode" : "execute-mode";
}

function readConfiguredReasoningDefaults(
  pluginConfig: unknown,
): CodexAppServerConversationReasoningDefaults | undefined {
  return readCodexAppServerConversationReasoningDefaults(
    readCodexPluginConfig(pluginConfig).appServer?.conversationReasoningDefaults,
  );
}

function formatCurrentReasoningEffortStatus(
  binding: {
    collaborationMode?: CodexAppServerCollaborationMode;
    reasoningEffort?: CodexAppServerReasoningEffort;
    reasoningEffortDefaults?: CodexAppServerConversationReasoningDefaults;
  },
  pluginConfig: unknown,
): string {
  const current = resolveCodexAppServerConversationReasoningEffort({
    mode: binding.collaborationMode,
    bindingDefaults: binding.reasoningEffortDefaults,
    legacyReasoningEffort: binding.reasoningEffort,
    configDefaults: readConfiguredReasoningDefaults(pluginConfig),
  });
  return `Codex think: ${formatReasoningEffort(current)}.`;
}

function formatReasoningEffortStatus(
  binding: {
    collaborationMode?: CodexAppServerCollaborationMode;
    reasoningEffort?: CodexAppServerReasoningEffort;
    reasoningEffortDefaults?: CodexAppServerConversationReasoningDefaults;
  },
  pluginConfig: unknown,
): string {
  const configDefaults = readConfiguredReasoningDefaults(pluginConfig);
  const current = resolveCodexAppServerConversationReasoningEffort({
    mode: binding.collaborationMode,
    bindingDefaults: binding.reasoningEffortDefaults,
    legacyReasoningEffort: binding.reasoningEffort,
    configDefaults,
  });
  const execute =
    binding.reasoningEffortDefaults?.execute ?? binding.reasoningEffort ?? configDefaults?.execute;
  const plan =
    binding.reasoningEffortDefaults?.plan ?? binding.reasoningEffort ?? configDefaults?.plan;
  return [
    `Codex think: ${formatReasoningEffort(current)}.`,
    `Execute default: ${formatReasoningEffort(execute)}.`,
    `Plan default: ${formatReasoningEffort(plan)}.`,
  ].join(" ");
}

async function requireThreadBinding(sessionFile: string, lookup: CodexAppServerBindingLookup = {}) {
  const binding = await readCodexAppServerBinding(sessionFile, lookup);
  if (!binding?.threadId) {
    throw new Error("No Codex thread is attached to this OpenClaw session yet.");
  }
  return binding;
}

async function resumeThreadWithOverrides(params: {
  pluginConfig?: unknown;
  threadId: string;
  authProfileId?: string;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
  model?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
}): Promise<CodexThreadResumeResponse> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...buildBindingLookup(params),
  });
  try {
    return await client.request(
      CODEX_CONTROL_METHODS.resumeThread,
      {
        threadId: params.threadId,
        ...(params.model ? { model: params.model } : {}),
        approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
        sandbox: params.sandbox ?? runtime.sandbox,
        approvalsReviewer: runtime.approvalsReviewer,
        ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
        persistExtendedHistory: true,
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
  } finally {
    releaseLeasedSharedCodexAppServerClient(client);
  }
}

function buildBindingLookup(params: {
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): CodexAppServerBindingLookup {
  const agentDir = params.agentDir?.trim();
  return {
    ...(agentDir ? { agentDir } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
}

function permissionsForMode(mode: PermissionsMode): {
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
} {
  return mode === "yolo"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}
