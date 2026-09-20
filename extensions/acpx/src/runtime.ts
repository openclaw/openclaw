/**
 * OpenClaw ACPX runtime adapter. It wraps the upstream acpx runtime with
 * OpenClaw session metadata, lease tracking, model scoping, and cleanup policy.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path, { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  isRequestedModelUnsupportedError,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeOptions,
  type AcpProcessLaunch,
  type AcpProcessStarted,
  type AcpRuntimeStatus,
  type AcpRuntimeTurnResult,
  type SessionAgentOptions,
} from "acpx/runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  AcpRuntimeError,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeErrorCode,
} from "../runtime-api.js";
import { CODEX_ACP_PACKAGE, OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  hashAcpxProcessCommand,
  readAcpxProcessLeaseIdentity,
  withAcpxLeaseArgs,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  isOpenClawLeaseAwareAcpxProcessCommand,
  type AcpxProcessCleanupDeps,
} from "./process-reaper.js";
import { AcpxGenerationRegistry } from "./runtime-generations.js";
import { prepareAcpxProcessCleanup } from "./runtime-process-cleanup.js";
import type { CompleteAcpRuntime, CompleteAcpRuntimeTurn } from "./runtime-proxy.js";
import {
  type AcpSessionStore,
  type AcpSessionRecord,
  type AcpLoadedSessionRecord,
  type ResetAwareSessionStore,
  type AcpxLaunchLeaseContext,
  type AcpxGeneration,
  captureGenerationRecord,
  acpxGenerationKey,
  type GenerationHandle,
  acpxOperationScope,
  readRecordAgentCommand,
  readRecordCwd,
  readRecordResetOnNextEnsure,
  readOpenClawLeaseIdFromRecord,
  extractGeneratedWrapperPath,
  createResetAwareSessionStore,
} from "./runtime-session-store.js";
import {
  assertAcpxSessionOwnerLocator,
  resolveAcpxSessionResource,
  toAcpxResourceInput,
} from "./session-owner.js";

type BaseAcpxRuntimeTestOptions = ConstructorParameters<typeof BaseAcpxRuntime>[1];
type OpenClawAcpxRuntimeOptions = AcpRuntimeOptions & {
  openclawLegacyBareSessionKeys?: ReadonlySet<string>;
  openclawWrapperRoot?: string;
  openclawGatewayInstanceId?: string;
  openclawProcessLeaseStore?: AcpxProcessLeaseStore;
  pluginToolsMcpBridgeEnabled?: boolean;
  openclawToolsMcpBridgeEnabled?: boolean;
};
type AcpxRuntimeTestOptions = Record<string, unknown> & {
  openclawProcessCleanup?: AcpxProcessCleanupDeps;
};
type OpenClawRuntimeEnsureInput = Parameters<AcpRuntime["ensureSession"]>[0];
type OpenClawRuntimeHandle = Awaited<ReturnType<AcpRuntime["ensureSession"]>>;
type AcpxDelegateEnsureInput = Parameters<BaseAcpxRuntime["ensureSession"]>[0];
type AcpxMcpServers = Extract<NonNullable<AcpRuntimeOptions["mcpServers"]>, unknown[]>;
type AcpxMcpServer = AcpxMcpServers[number];

const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";
const ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME = "openclaw-tools";
const OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY";
type AcpxHandleOperationSnapshot = Readonly<{
  generation: AcpxGeneration;
  record: AcpLoadedSessionRecord;
  command: AcpxAgentCommand | undefined;
}>;

const CODEX_WRAPPER_STDERR_LOG_PREFIX = "codex-acp-wrapper.stderr";
const CODEX_WRAPPER_ERROR_TAIL_MAX_CHARS = 6_000;

function safeDiagnosticFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function codexWrapperStderrLogFileName(leaseId: string): string {
  return `${CODEX_WRAPPER_STDERR_LOG_PREFIX}.${safeDiagnosticFilePart(leaseId)}.log`;
}

function compactDiagnosticText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isGenericInternalAcpErrorMessage(message: string): boolean {
  return message.trim() === "Internal error";
}

function isGenericInternalAcpError(error: unknown): error is Error {
  return error instanceof Error && isGenericInternalAcpErrorMessage(error.message);
}

async function readCodexWrapperStderrTail(params: {
  wrapperRoot: string | undefined;
  leaseId: string | undefined;
}): Promise<string> {
  if (!params.wrapperRoot || !params.leaseId) {
    return "";
  }
  try {
    const text = await fs.readFile(
      path.join(params.wrapperRoot, codexWrapperStderrLogFileName(params.leaseId)),
      "utf8",
    );
    return compactDiagnosticText(
      redactSensitiveText(sliceUtf16Safe(text, -CODEX_WRAPPER_ERROR_TAIL_MAX_CHARS)),
    );
  } catch {
    return "";
  }
}

const OPENCLAW_BRIDGE_EXECUTABLE = "openclaw";
const OPENCLAW_BRIDGE_SUBCOMMAND = "acp";
const CODEX_ACP_AGENT_ID = "codex";
const CODEX_ACP_OPENCLAW_PREFIX = "openai/";
// Documented OpenClaw provider prefixes the Claude Agent SDK does not understand.
// Strip only these; a generic first-slash split would corrupt native Bedrock
// inference-profile ids and ARNs the SDK accepts as-is.
const CLAUDE_ACP_OPENCLAW_PREFIX = /^(?:anthropic|amazon-bedrock)\//i;
const CODEX_ACP_THINKING_ALIASES = new Map<string, string | undefined>([
  ["off", undefined],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["x-high", "xhigh"],
  ["x_high", "xhigh"],
  ["extra-high", "xhigh"],
  ["extra_high", "xhigh"],
  ["extra high", "xhigh"],
  ["xhigh", "xhigh"],
]);

type CodexAcpModelOverride = {
  model?: string;
  reasoningEffort?: string;
};

type CodexAcpModelClassification =
  | { kind: "override"; override: CodexAcpModelOverride }
  | { kind: "unsupported"; thinkingOverride?: CodexAcpModelOverride };

function normalizeAgentName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function readAgentFromSessionKey(sessionKey: string | undefined): string | undefined {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return undefined;
  }
  const match = /^agent:(?<agent>[^:]+):/i.exec(normalized);
  return normalizeAgentName(match?.groups?.agent);
}

function readAgentFromHandle(handle: OpenClawRuntimeHandle): string | undefined {
  const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
  return normalizeAgentName(decoded?.agent) ?? readAgentFromSessionKey(handle.sessionKey);
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function unwrapEnvCommand(parts: string[]): string[] {
  const command = parts.at(0);
  if (!command || basename(command) !== "env") {
    return parts;
  }
  let index = 1;
  while (true) {
    const part = parts.at(index);
    if (!part || !isEnvAssignment(part)) {
      break;
    }
    index += 1;
  }
  return parts.slice(index);
}

function matchesExecutableName(value: string, executableName: string): boolean {
  const normalized = basename(value).toLowerCase();
  return normalized === executableName || normalized === `${executableName}.exe`;
}

function matchesPackageSpec(value: string, packageName: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === packageName || normalized.startsWith(`${packageName}@`);
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.[cm]?js$/i, "").toLowerCase();
}

function isAcpCommand(
  command: AcpxAgentCommand | undefined,
  params: { packageName: string; executableName: string },
): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command));
  if (!parts.length) {
    return false;
  }
  if (parts.some((part) => matchesPackageSpec(part, params.packageName))) {
    return true;
  }
  const commandName = basename(parts[0] ?? "");
  if (matchesExecutableName(commandName, params.executableName)) {
    return true;
  }
  if (!matchesExecutableName(commandName, "node")) {
    return false;
  }
  const scriptName = stripModuleExtension(basename(parts[1] ?? ""));
  return scriptName === params.executableName || scriptName === `${params.executableName}-wrapper`;
}

function isOpenClawBridgeCommand(command: AcpxAgentCommand | undefined): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command));
  if (basename(parts[0] ?? "") === OPENCLAW_BRIDGE_EXECUTABLE) {
    return parts[1] === OPENCLAW_BRIDGE_SUBCOMMAND;
  }
  if (basename(parts[0] ?? "") !== "node") {
    return false;
  }
  const scriptName = basename(parts[1] ?? "");
  return /^openclaw(?:\.[cm]?js)?$/i.test(scriptName) && parts[2] === OPENCLAW_BRIDGE_SUBCOMMAND;
}

function isCodexAcpCommand(command: AcpxAgentCommand | undefined): boolean {
  return isAcpCommand(command, {
    packageName: CODEX_ACP_PACKAGE,
    executableName: "codex-acp",
  });
}

function isClaudeAcpCommand(command: AcpxAgentCommand | undefined): boolean {
  return isAcpCommand(command, {
    packageName: "@agentclientprotocol/claude-agent-acp",
    executableName: "claude-agent-acp",
  });
}

function failUnsupportedCodexAcpModel(rawModel: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP model "${rawModel}" is not supported. Use openai/<model> or <model>/<reasoning-effort>.`,
  );
}

const WIRE_TIMEOUT_CONFIG_KEYS = new Set(["timeout", "timeout_seconds"]);

// The handle codec coerces unknown modes to persistent; reject them before encoding.
function assertSupportedRuntimeSessionMode(
  mode: unknown,
): asserts mode is "persistent" | "oneshot" {
  if (mode === "persistent" || mode === "oneshot") {
    return;
  }
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Unsupported ACP runtime session mode ${JSON.stringify(mode)}. Expected one of: persistent, oneshot.`,
  );
}

function failUnsupportedCodexAcpThinking(rawThinking: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP thinking level "${rawThinking}" is not supported. Use off, minimal, low, medium, high, or xhigh.`,
  );
}

function normalizeCodexAcpReasoningEffort(rawThinking: string | undefined): string | undefined {
  const normalized = rawThinking?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!CODEX_ACP_THINKING_ALIASES.has(normalized)) {
    failUnsupportedCodexAcpThinking(rawThinking ?? "");
  }
  return CODEX_ACP_THINKING_ALIASES.get(normalized);
}

function isCodexAcpReasoningEffortAlias(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && CODEX_ACP_THINKING_ALIASES.has(normalized));
}

function classifyCodexAcpModelRequest(
  rawModel: string | undefined,
  rawThinking?: string,
): CodexAcpModelClassification {
  const raw = rawModel?.trim();
  const thinkingReasoningEffort = normalizeCodexAcpReasoningEffort(rawThinking);
  const thinkingOnlyOverride = thinkingReasoningEffort
    ? { reasoningEffort: thinkingReasoningEffort }
    : undefined;
  if (!raw) {
    return { kind: "override", override: thinkingOnlyOverride ?? {} };
  }

  let value = raw;
  let hadOpenAiQualifier = false;
  if (value.toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)) {
    value = value.slice(CODEX_ACP_OPENCLAW_PREFIX.length);
    hadOpenAiQualifier = true;
  }

  let model = value.trim();
  let modelReasoningEffort: string | undefined;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex >= 0 && isCodexAcpReasoningEffortAlias(value.slice(slashIndex + 1))) {
    modelReasoningEffort = normalizeCodexAcpReasoningEffort(value.slice(slashIndex + 1));
    model = value.slice(0, slashIndex).trim();
  }

  if (hadOpenAiQualifier && (!model || model.includes("/"))) {
    failUnsupportedCodexAcpModel(raw);
  }
  if (!model || model.includes("/")) {
    return thinkingOnlyOverride
      ? { kind: "unsupported", thinkingOverride: thinkingOnlyOverride }
      : { kind: "unsupported" };
  }

  // Explicit `off` omits the override even when the model carries an effort suffix.
  const reasoningEffort = rawThinking?.trim() ? thinkingReasoningEffort : modelReasoningEffort;
  return {
    kind: "override",
    override: {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

function withCodexSessionModel<T extends { model?: string }>(
  input: T,
  override: CodexAcpModelOverride | undefined,
): T {
  const next = { ...input };
  if (override?.model) {
    next.model = override.model;
  } else {
    delete next.model;
  }
  return next;
}

function normalizeClaudeAcpModelOverride(rawModel: string | undefined): string | undefined {
  const raw = rawModel?.trim();
  if (!raw) {
    return undefined;
  }
  const prefix = raw.match(CLAUDE_ACP_OPENCLAW_PREFIX);
  if (!prefix) {
    return raw;
  }
  return raw.slice(prefix[0].length).trim() || undefined;
}

function withAcpxSessionOptions(input: OpenClawRuntimeEnsureInput): AcpxDelegateEnsureInput {
  const existingOptions = (input as { sessionOptions?: SessionAgentOptions }).sessionOptions;
  const model = input.model?.trim() || existingOptions?.model;
  const sessionOptions = model ? { ...existingOptions, model } : existingOptions;
  const { modelExplicit: _modelExplicit, thinkingExplicit: _thinkingExplicit, ...rest } = input;
  return {
    ...rest,
    ...(sessionOptions ? { sessionOptions } : {}),
  } as AcpxDelegateEnsureInput;
}

function isAcpModelCapabilityMissingError(error: unknown): boolean {
  return isRequestedModelUnsupportedError(error) && error.reason === "missing-capability";
}

// Only inherited defaults may be dropped when a harness has no model control;
// explicit selections and invalid model ids must remain visible failures.
async function ensureDelegateSessionWithModelFallback(
  delegate: BaseAcpxRuntime,
  input: OpenClawRuntimeEnsureInput,
): Promise<OpenClawRuntimeHandle> {
  try {
    return await delegate.ensureSession(withAcpxSessionOptions(input));
  } catch (error) {
    if (input.modelExplicit || !input.model || !isAcpModelCapabilityMissingError(error)) {
      throw error;
    }
    return {
      ...(await delegate.ensureSession(withAcpxSessionOptions({ ...input, model: undefined }))),
      appliedModel: { kind: "dropped" },
    };
  }
}

function appendCodexAcpConfigOverrides(
  command: AcpxAgentCommand,
  override: CodexAcpModelOverride,
): AcpxAgentCommand {
  const config = {
    ...(override.model ? { model: override.model } : {}),
    ...(override.reasoningEffort ? { model_reasoning_effort: override.reasoningEffort } : {}),
  };
  if (Object.keys(config).length === 0) {
    return command;
  }
  return [...splitCommandParts(command), OPENCLAW_CODEX_CONFIG_ARG, JSON.stringify(config)];
}

function resolveAgentCommand(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): AcpxAgentCommand | undefined {
  const normalizedAgentName = normalizeAgentName(params.agentName);
  if (!normalizedAgentName) {
    return undefined;
  }
  return splitCommandParts(params.agentRegistry.resolve(normalizedAgentName));
}

function withManagedToolsMcpSessionEnv(params: {
  pluginToolsEnabled: boolean;
  openclawToolsEnabled: boolean;
  mcpServers: AcpxMcpServers;
  sessionKey: string;
  agentId?: string;
}): AcpxMcpServers {
  const sessionKey = params.sessionKey.trim();
  if (
    (!params.pluginToolsEnabled && !params.openclawToolsEnabled) ||
    !sessionKey ||
    !params.mcpServers?.length
  ) {
    return params.mcpServers;
  }
  let changed = false;
  const nextServers = params.mcpServers.map((server): AcpxMcpServer => {
    const isManagedPluginTools =
      params.pluginToolsEnabled && server.name === ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME;
    const isManagedOpenClawTools =
      params.openclawToolsEnabled && server.name === ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME;
    if ((!isManagedPluginTools && !isManagedOpenClawTools) || !("command" in server)) {
      return server;
    }
    changed = true;
    const env = [
      ...server.env.filter((entry) => entry.name !== OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV),
      {
        name: OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
        value: sessionKey,
      },
    ];
    return {
      ...server,
      env,
      args: params.agentId ? [...server.args, "--openclaw-agent-id", params.agentId] : server.args,
    };
  });
  return changed ? nextServers : params.mcpServers;
}

/** OpenClaw-managed ACP runtime implementation backed by the upstream acpx runtime. */
export class AcpxRuntime implements CompleteAcpRuntime {
  readonly ownerAwareSessions = 1 as const;
  private readonly legacyBareSessionKeys: Set<string>;
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly agentRegistry: AcpAgentRegistry;
  private readonly scopedAgentRegistry: AcpAgentRegistry;
  private readonly launchCommandScope = new AsyncLocalStorage<{
    agent: string;
    command: AcpxAgentCommand | undefined;
  }>();
  private readonly delegate: BaseAcpxRuntime;
  private readonly generationRegistry: AcpxGenerationRegistry;
  private readonly createDelegate: () => BaseAcpxRuntime;
  private readonly sessionScope = new AsyncLocalStorage<{ sessionKey: string; agentId?: string }>();
  private readonly probeQueue = new KeyedAsyncQueue();
  private readonly probeAgent: string;
  private readonly probeCommand: AcpxAgentCommand | undefined;
  private readonly pluginToolsMcpBridgeEnabled: boolean;
  private readonly openclawToolsMcpBridgeEnabled: boolean;
  private readonly managedToolsMcpBridgeEnabled: boolean;
  private readonly processCleanupDeps: AcpxProcessCleanupDeps | undefined;
  private readonly wrapperRoot: string | undefined;
  private readonly gatewayInstanceId: string | undefined;
  private readonly processLeaseStore: AcpxProcessLeaseStore | undefined;
  private readonly launchLeaseScope = new AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>();
  private readonly cwd: string;

  constructor(options: OpenClawAcpxRuntimeOptions, testOptions?: AcpxRuntimeTestOptions) {
    this.legacyBareSessionKeys = new Set(options.openclawLegacyBareSessionKeys);
    const { openclawProcessCleanup, ...delegateTestOptions } = testOptions ?? {};
    this.processCleanupDeps = openclawProcessCleanup;
    this.wrapperRoot = options.openclawWrapperRoot;
    this.gatewayInstanceId = options.openclawGatewayInstanceId;
    this.processLeaseStore = options.openclawProcessLeaseStore;
    this.pluginToolsMcpBridgeEnabled = options.pluginToolsMcpBridgeEnabled === true;
    this.openclawToolsMcpBridgeEnabled = options.openclawToolsMcpBridgeEnabled === true;
    this.managedToolsMcpBridgeEnabled =
      this.pluginToolsMcpBridgeEnabled || this.openclawToolsMcpBridgeEnabled;
    this.cwd = options.cwd;
    this.sessionStore = createResetAwareSessionStore(options.sessionStore, {
      gatewayInstanceId: this.gatewayInstanceId,
      leaseStore: this.processLeaseStore,
      launchScope: this.launchLeaseScope,
      wrapperRoot: this.wrapperRoot,
    });
    this.agentRegistry = options.agentRegistry;
    this.scopedAgentRegistry = {
      resolve: (agentName) => {
        const launch = this.launchCommandScope.getStore();
        return launch && launch.agent === normalizeAgentName(agentName) && launch.command
          ? launch.command
          : this.agentRegistry.resolve(agentName);
      },
      list: () => this.agentRegistry.list(),
    };
    this.createDelegate = () =>
      new BaseAcpxRuntime(
        {
          ...options,
          sessionStore: this.sessionStore,
          agentRegistry: this.scopedAgentRegistry,
          mcpServers: (context) => {
            const servers =
              typeof options.mcpServers === "function"
                ? options.mcpServers(context)
                : (options.mcpServers ?? []);
            if (isOpenClawBridgeCommand(context.agentArgv ?? context.agentCommand)) {
              return [];
            }
            const target = this.sessionScope.getStore();
            if (!this.managedToolsMcpBridgeEnabled) {
              return servers;
            }
            if (!target) {
              throw new AcpRuntimeError(
                "ACP_SESSION_INIT_FAILED",
                "ACP tool bridge has no session owner",
              );
            }
            return withManagedToolsMcpSessionEnv({
              pluginToolsEnabled: this.pluginToolsMcpBridgeEnabled,
              openclawToolsEnabled: this.openclawToolsMcpBridgeEnabled,
              mcpServers: servers,
              ...target,
            });
          },
          processLifecycle: {
            onBeforeSpawn: async (launch) => {
              await options.processLifecycle?.onBeforeSpawn?.(launch);
              await this.recordProcessLaunch(launch);
            },
            onSpawned: async (process) => {
              await this.recordProcessLaunch(process);
              await options.processLifecycle?.onSpawned?.(process);
            },
            onSpawnFailed: options.processLifecycle?.onSpawnFailed,
            onExit: options.processLifecycle?.onExit,
          },
        },
        delegateTestOptions as BaseAcpxRuntimeTestOptions,
      );
    this.delegate = this.createDelegate();
    this.generationRegistry = new AcpxGenerationRegistry(
      this.sessionStore,
      this.delegate,
      this.createDelegate,
    );
    this.probeAgent = normalizeAgentName(options.probeAgent) ?? "codex";
    const probeCommand = resolveAgentCommand({
      agentName: this.probeAgent,
      agentRegistry: this.agentRegistry,
    });
    this.probeCommand = probeCommand;
  }

  private async runInGeneration<T>(
    target: { sessionKey: string; agentId?: string; acpxRecordId?: string },
    scope: { generation: AcpxGeneration; closeRecord?: AcpLoadedSessionRecord; recordId?: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const release = this.generationRegistry.retainGenerationOperation(
      scope.generation,
      scope.recordId ?? target.acpxRecordId ?? scope.generation.resource,
    );
    try {
      return await this.sessionScope.run(target, () => acpxOperationScope.run(scope, run));
    } finally {
      release();
    }
  }

  private resolveDelegateForSession(params: {
    command: AcpxAgentCommand | undefined;
    sessionKey: string;
    agentId?: string;
  }): BaseAcpxRuntime {
    const generation =
      acpxOperationScope.getStore()?.generation ??
      this.generationRegistry.currentGeneration(resolveAcpxSessionResource(params));
    return this.generationRegistry.resolveDelegate(generation);
  }

  private generationForHandle(handle: OpenClawRuntimeHandle): AcpxGeneration {
    const resource = assertAcpxSessionOwnerLocator(
      { ...handle, persistedHandle: handle },
      this.legacyBareSessionKeys,
    );
    const capturedGeneration = (handle as GenerationHandle)[acpxGenerationKey];
    return this.generationRegistry.fromCaptured(resource, capturedGeneration);
  }

  private async loadOperationSnapshotForHandle(
    handle: OpenClawRuntimeHandle,
    generation: AcpxGeneration,
    allowRetired = false,
  ): Promise<AcpxHandleOperationSnapshot> {
    const resource = generation.resource;
    if (!allowRetired) {
      this.generationRegistry.assertCurrentGeneration(generation);
    }
    const ownedRecord = generation.records.get(handle.acpxRecordId ?? resource);
    if (
      ownedRecord &&
      ((handle.acpxRecordId && ownedRecord.acpxRecordId !== handle.acpxRecordId) ||
        (handle.backendSessionId &&
          ownedRecord.acpSessionId &&
          ownedRecord.acpSessionId !== handle.backendSessionId))
    ) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP handle no longer owns this runtime generation.",
      );
    }
    let record = allowRetired
      ? generation.retired
        ? ownedRecord
        : await this.sessionStore.loadForClose(handle.acpxRecordId ?? resource)
      : await acpxOperationScope.run({ generation }, () =>
          this.sessionStore.load(handle.acpxRecordId ?? resource),
        );
    // A reset can retire this generation while the snapshot read is pending.
    // Prefer its captured record over any replacement now visible in storage.
    if (allowRetired && generation.retired && ownedRecord) {
      record = ownedRecord;
    }
    if (allowRetired && record) {
      captureGenerationRecord(generation, record);
    }
    if (!allowRetired) {
      this.generationRegistry.assertCurrentGeneration(generation);
    }
    if (
      record &&
      ((handle.acpxRecordId && handle.acpxRecordId !== record.acpxRecordId) ||
        (handle.backendSessionId &&
          record.acpSessionId &&
          handle.backendSessionId !== record.acpSessionId))
    ) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP handle no longer owns this runtime record.",
      );
    }
    const command =
      readRecordAgentCommand(record) ??
      resolveAgentCommand({
        agentName: readAgentFromHandle(handle),
        agentRegistry: this.agentRegistry,
      });
    const identity = readAcpxProcessLeaseIdentity(command);
    if (identity && this.processLeaseStore && this.gatewayInstanceId && this.wrapperRoot) {
      const lease = await this.processLeaseStore.load(identity.leaseId);
      if (identity.gatewayInstanceId !== this.gatewayInstanceId) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `ACPX process lease ${identity.leaseId} belongs to another gateway`,
        );
      }
      if (
        lease &&
        (lease.gatewayInstanceId !== identity.gatewayInstanceId ||
          lease.sessionKey !== resolveAcpxSessionResource(handle) ||
          lease.wrapperRoot !== this.wrapperRoot)
      ) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `ACPX process lease ${identity.leaseId} belongs to another session`,
        );
      }
    }
    if (!allowRetired) {
      this.generationRegistry.assertCurrentGeneration(generation);
    }
    return { record, command, generation };
  }

  private async runWithOperationSnapshot<T>(
    handle: OpenClawRuntimeHandle,
    run: (snapshot: AcpxHandleOperationSnapshot) => Promise<T>,
  ): Promise<T> {
    const generation = this.generationForHandle(handle);
    // Hold the owner before lookup can yield; the verified record gets its own
    // reservation without leaving a gap between snapshot and operation custody.
    return await this.runInGeneration(handle, { generation }, async () => {
      const snapshot = await this.loadOperationSnapshotForHandle(handle, generation);
      this.generationRegistry.assertCurrentGeneration(generation);
      return await this.runInGeneration(
        handle,
        { generation, recordId: snapshot.record?.acpxRecordId },
        () => run(snapshot),
      );
    });
  }

  private resolveDelegateForOperationSnapshot(
    handle: OpenClawRuntimeHandle,
    snapshot: AcpxHandleOperationSnapshot,
  ): BaseAcpxRuntime {
    return acpxOperationScope.run(
      { generation: snapshot.generation, recordId: snapshot.record?.acpxRecordId },
      () =>
        this.resolveDelegateForSession({
          command: snapshot.command,
          sessionKey: handle.sessionKey,
          agentId: handle.agentId,
        }),
    );
  }

  private async readReusablePersistentSessionCommand(params: {
    sessionKey: string;
    mode: Parameters<AcpRuntime["ensureSession"]>[0]["mode"];
    cwd: string | undefined;
    command: AcpxAgentCommand | undefined;
    resumeSessionId: string | undefined;
  }): Promise<AcpxAgentCommand | undefined> {
    if (params.mode !== "persistent" || !params.command) {
      return undefined;
    }
    const existing = await this.sessionStore.load(params.sessionKey);
    if (!existing || readRecordResetOnNextEnsure(existing)) {
      return undefined;
    }
    const recordCwd = readRecordCwd(existing);
    if (!recordCwd || resolvePath(recordCwd) !== resolvePath(params.cwd?.trim() || this.cwd)) {
      return undefined;
    }
    const recordCommand = readRecordAgentCommand(existing);
    if (!recordCommand) {
      return undefined;
    }
    const leaseIdentity = readAcpxProcessLeaseIdentity(recordCommand);
    if (leaseIdentity && leaseIdentity.gatewayInstanceId !== this.gatewayInstanceId) {
      return undefined;
    }
    const stableRecordCommand = leaseIdentity
      ? withAcpxLeaseArgs({
          command: params.command,
          leaseId: leaseIdentity.leaseId,
          gatewayInstanceId: leaseIdentity.gatewayInstanceId,
        })
      : params.command;
    if (
      !isDeepStrictEqual(splitCommandParts(recordCommand), splitCommandParts(stableRecordCommand))
    ) {
      return undefined;
    }
    return !params.resumeSessionId || existing.acpSessionId === params.resumeSessionId
      ? recordCommand
      : undefined;
  }

  private async runWithLaunchLease<T>(params: {
    agent: string;
    sessionKey: string;
    command: AcpxAgentCommand | undefined;
    reusableCommand?: AcpxAgentCommand;
    finalizeCompletedProbe?: boolean;
    run: () => Promise<T>;
  }): Promise<T> {
    if (
      !params.command ||
      !this.wrapperRoot ||
      !this.gatewayInstanceId ||
      !this.processLeaseStore ||
      !isOpenClawLeaseAwareAcpxProcessCommand({
        command: params.command,
        wrapperRoot: this.wrapperRoot,
      })
    ) {
      return await this.launchCommandScope.run(
        {
          agent: normalizeAgentName(params.agent) ?? params.agent,
          command: params.reusableCommand ?? params.command,
        },
        params.run,
      );
    }
    const reusableIdentity = readAcpxProcessLeaseIdentity(params.reusableCommand);
    const canReuseLeaseIdentity = reusableIdentity?.gatewayInstanceId === this.gatewayInstanceId;
    // Repeated probes share one uncertainty row per Gateway and wrapper. Unique probe rows could
    // otherwise evict live session ownership from the bounded lease namespace.
    const leaseId = canReuseLeaseIdentity
      ? reusableIdentity.leaseId
      : params.finalizeCompletedProbe
        ? `probe-${hashAcpxProcessCommand(
            `${this.gatewayInstanceId}\0${extractGeneratedWrapperPath(params.command)}`,
          )}`
        : randomUUID();
    const leasedCommand = withAcpxLeaseArgs({
      command: params.command,
      leaseId,
      gatewayInstanceId: this.gatewayInstanceId,
    });
    const launch: AcpxLaunchLeaseContext = {
      leaseId,
      gatewayInstanceId: this.gatewayInstanceId,
      sessionKey: params.sessionKey,
      wrapperRoot: this.wrapperRoot,
      resolvedCommand: params.reusableCommand ?? leasedCommand,
      leasedCommand,
    };
    const result = await this.launchLeaseScope.run(launch, () =>
      this.launchCommandScope.run(
        {
          agent: normalizeAgentName(params.agent) ?? params.agent,
          command: launch.resolvedCommand,
        },
        params.run,
      ),
    );
    if (params.finalizeCompletedProbe) {
      await cleanupOpenClawOwnedAcpxPendingLease({
        leaseId,
        gatewayInstanceId: launch.gatewayInstanceId,
        wrapperRoot: launch.wrapperRoot,
        wrapperPath: extractGeneratedWrapperPath(leasedCommand),
        deps: this.processCleanupDeps,
      });
    }
    return result;
  }

  private async recordProcessLaunch(process: AcpProcessLaunch | AcpProcessStarted): Promise<void> {
    const command = [process.command, ...process.args];
    const identity = readAcpxProcessLeaseIdentity(command);
    if (!identity || !this.processLeaseStore || !this.wrapperRoot) {
      return;
    }
    const sessionKey =
      process.scope.kind === "runtime-session"
        ? process.scope.sessionKey
        : ACPX_PROBE_LEASE_SESSION_KEY;
    const existing = await this.processLeaseStore.load(identity.leaseId);
    if (
      identity.gatewayInstanceId !== this.gatewayInstanceId ||
      (existing &&
        (existing.gatewayInstanceId !== identity.gatewayInstanceId ||
          existing.sessionKey !== sessionKey ||
          existing.wrapperRoot !== this.wrapperRoot))
    ) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "ACP process lease belongs to another owner",
      );
    }
    if (!isOpenClawLeaseAwareAcpxProcessCommand({ command, wrapperRoot: this.wrapperRoot })) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "ACP process lease has no owned wrapper",
      );
    }
    await this.processLeaseStore.save({
      ...identity,
      sessionKey,
      wrapperRoot: this.wrapperRoot,
      wrapperPath: extractGeneratedWrapperPath(command),
      rootPid: "pid" in process ? process.pid : 0,
      commandHash: hashAcpxProcessCommand(command),
      startedAt: "startedAt" in process ? Date.parse(process.startedAt) : Date.now(),
      state: "open",
    });
  }

  private async withCodexWrapperDiagnostics<T>(params: {
    command: AcpxAgentCommand | undefined;
    fallbackCode: AcpRuntimeErrorCode;
    handle?: OpenClawRuntimeHandle;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (error) {
      if (!isCodexAcpCommand(params.command) || !isGenericInternalAcpError(error)) {
        throw error;
      }
      const stderrTail = params.handle
        ? await this.readCodexTurnFailureStderr({ handle: params.handle })
        : await readCodexWrapperStderrTail({
            wrapperRoot: this.wrapperRoot,
            leaseId: this.launchLeaseScope.getStore()?.leaseId,
          });
      if (!stderrTail) {
        throw error;
      }
      throw new AcpRuntimeError(params.fallbackCode, `Internal error: ${stderrTail}`, {
        cause: error,
      });
    }
  }

  private async readCodexTurnFailureStderr(params: {
    handle: OpenClawRuntimeHandle;
  }): Promise<string> {
    const record = await this.sessionStore.load(
      params.handle.acpxRecordId ?? resolveAcpxSessionResource(params.handle),
    );
    return readCodexWrapperStderrTail({
      wrapperRoot: this.wrapperRoot,
      leaseId: readOpenClawLeaseIdFromRecord(record),
    });
  }

  async shutdown(): Promise<void> {
    await this.generationRegistry.shutdown();
  }

  isHealthy(): boolean {
    return this.delegate.isHealthy();
  }

  async probeAvailability(): Promise<void> {
    await this.probeQueue.enqueue(this.probeAgent, () =>
      this.runWithLaunchLease({
        agent: this.probeAgent,
        sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
        command: this.probeCommand,
        finalizeCompletedProbe: true,
        run: () => this.delegate.probeAvailability(),
      }),
    );
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    return await this.probeQueue.enqueue(this.probeAgent, () =>
      this.runWithLaunchLease({
        agent: this.probeAgent,
        sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
        command: this.probeCommand,
        finalizeCompletedProbe: true,
        run: () => this.delegate.doctor(),
      }),
    );
  }

  async ensureSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<OpenClawRuntimeHandle> {
    const resource = assertAcpxSessionOwnerLocator(input, this.legacyBareSessionKeys);
    return await this.generationRegistry.runAdmission(resource, (generation) =>
      this.runInGeneration(input, { generation }, async () => {
        this.generationRegistry.assertCurrentGeneration(generation);
        const handle = {
          ...(await this.ensureSessionUnlocked(input)),
          [acpxGenerationKey]: generation,
        };
        if (generation.retired && !this.generationRegistry.isStopping) {
          // ACPX can retain a live client before the reset fence observes this
          // result. Keep the exact handle reachable until its cleanup settles.
          await this.close({
            handle,
            reason: "superseded-initialization",
            discardPersistentState: true,
          });
        }
        this.generationRegistry.assertCurrentGeneration(generation);
        return handle;
      }),
    );
  }

  private async ensureSessionUnlocked(
    logicalInput: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<OpenClawRuntimeHandle> {
    assertSupportedRuntimeSessionMode(logicalInput.mode);
    const command = resolveAgentCommand({
      agentName: logicalInput.agent,
      agentRegistry: this.agentRegistry,
    });
    const delegate = this.resolveDelegateForSession({
      command,
      sessionKey: logicalInput.sessionKey,
      agentId: logicalInput.agentId,
    });
    const logicalTarget = { sessionKey: logicalInput.sessionKey, agentId: logicalInput.agentId };
    const input = { ...logicalInput, sessionKey: resolveAcpxSessionResource(logicalInput) };
    const isCodexAcp =
      normalizeAgentName(input.agent) === CODEX_ACP_AGENT_ID && isCodexAcpCommand(command);
    const dropInheritedCodexMax =
      isCodexAcp && input.thinking === "max" && input.thinkingExplicit === false;
    const effectiveInput = dropInheritedCodexMax ? { ...input } : input;
    if (dropInheritedCodexMax) {
      delete effectiveInput.thinking;
    }
    const claudeModelOverride = isClaudeAcpCommand(command)
      ? normalizeClaudeAcpModelOverride(input.model)
      : undefined;
    const codexClassification = isCodexAcp
      ? classifyCodexAcpModelRequest(effectiveInput.model, effectiveInput.thinking)
      : undefined;
    if (codexClassification?.kind === "unsupported" && input.modelExplicit) {
      failUnsupportedCodexAcpModel(input.model ?? "");
    }
    const classifiedCodexOverride =
      codexClassification?.kind === "override"
        ? codexClassification.override
        : codexClassification?.thinkingOverride;
    const codexModelOverride =
      classifiedCodexOverride && Object.keys(classifiedCodexOverride).length > 0
        ? classifiedCodexOverride
        : undefined;
    const requestedModel = effectiveInput.model?.trim();
    const appliedModel: OpenClawRuntimeHandle["appliedModel"] =
      isCodexAcp && requestedModel
        ? codexModelOverride?.model
          ? { kind: "applied", model: requestedModel }
          : { kind: "dropped" }
        : undefined;
    const ensureInput = isCodexAcp
      ? withCodexSessionModel(effectiveInput, codexModelOverride)
      : claudeModelOverride
        ? { ...effectiveInput, model: claudeModelOverride }
        : effectiveInput;
    const stableLaunchCommand =
      codexModelOverride && command
        ? appendCodexAcpConfigOverrides(command, codexModelOverride)
        : command;
    const reusableCommand = await this.readReusablePersistentSessionCommand({
      sessionKey: input.sessionKey,
      mode: input.mode,
      cwd: input.cwd,
      command: stableLaunchCommand,
      resumeSessionId: input.resumeSessionId,
    });

    const handle = await this.runWithLaunchLease({
      agent: ensureInput.agent,
      sessionKey: ensureInput.sessionKey,
      command: stableLaunchCommand,
      reusableCommand,
      run: () =>
        this.withCodexWrapperDiagnostics({
          command: stableLaunchCommand,
          fallbackCode: "ACP_SESSION_INIT_FAILED",
          run: () =>
            codexModelOverride
              ? delegate.ensureSession(withAcpxSessionOptions(ensureInput))
              : ensureDelegateSessionWithModelFallback(delegate, ensureInput),
        }),
    });
    return {
      ...handle,
      ...logicalTarget,
      ...(appliedModel ? { appliedModel } : {}),
      ...(dropInheritedCodexMax ? { appliedThinking: { kind: "dropped" as const } } : {}),
    };
  }

  async *runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    const turn = this.startTurn(input);
    // Observe terminal rejection while the consumer is still reading events.
    void turn.result.catch(() => {});
    let completed = false;
    try {
      yield* turn.events;
      const result = await turn.result;
      completed = true;
      yield result.status === "failed"
        ? { type: "error", ...result.error }
        : { type: "done", ...(result.stopReason ? { stopReason: result.stopReason } : {}) };
    } finally {
      if (!completed) {
        // Ending iteration closes only the consumer. The turn result owns lease cleanup.
        await turn.cancel({ reason: "stream-closed" }).catch(() => {});
        await turn.closeStream({ reason: "stream-closed" }).catch(() => {});
        await turn.result.catch(() => {});
      }
    }
  }

  startTurn(input: Parameters<NonNullable<AcpRuntime["startTurn"]>>[0]): CompleteAcpRuntimeTurn {
    const withTurnDiagnostics = <T>(command: AcpxAgentCommand | undefined, run: () => Promise<T>) =>
      this.withCodexWrapperDiagnostics({
        command,
        handle: input.handle,
        fallbackCode: "ACP_TURN_FAILED",
        run,
      });
    const turnPromise = this.runWithOperationSnapshot(input.handle, (snapshot) => {
      const { command, generation } = snapshot;
      this.generationRegistry.assertCurrentGeneration(generation);
      const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
      return this.sessionScope.run(input.handle, () =>
        acpxOperationScope.run({ generation }, () =>
          withTurnDiagnostics(command, async () => {
            const release = this.generationRegistry.retainGenerationOperation(
              generation,
              snapshot.record?.acpxRecordId ?? input.handle.acpxRecordId ?? generation.resource,
            );
            try {
              const turn = delegate.startTurn({
                ...toAcpxResourceInput(input),
                // OpenClaw owns deadlines; ACPX must not complete partial output.
                timeoutMs: 0,
              });
              void turn.result.then(release, release);
              return { command, turn };
            } catch (error) {
              release();
              throw error;
            }
          }),
        ),
      );
    });

    return {
      requestId: input.requestId,
      get promptStarted() {
        return turnPromise.then(({ turn }) => turn.promptStarted);
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
          const { command, turn } = await turnPromise;
          try {
            yield* turn.events;
          } catch (error) {
            if (!isGenericInternalAcpError(error)) {
              throw error;
            }
            await withTurnDiagnostics(command, () => Promise.reject(error));
          }
        },
      },
      result: turnPromise.then(({ command, turn }) =>
        withTurnDiagnostics(command, async (): Promise<AcpRuntimeTurnResult> => {
          const result = await turn.result;
          if (
            result.status !== "failed" ||
            !isCodexAcpCommand(command) ||
            !isGenericInternalAcpErrorMessage(result.error.message)
          ) {
            return result;
          }
          const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
          if (!stderrTail) {
            return result;
          }
          return {
            status: "failed",
            error: {
              ...result.error,
              code: "ACP_TURN_FAILED",
              message: `Internal error: ${stderrTail}`,
            },
          };
        }),
      ),
      cancel(inputArgs?: { reason?: string }) {
        return turnPromise.then(({ turn }) => turn.cancel(inputArgs));
      },
      closeStream(inputArgs?: { reason?: string }) {
        return turnPromise.then(({ turn }) => turn.closeStream(inputArgs));
      },
    };
  }

  async getCapabilities(
    input?: Parameters<NonNullable<AcpRuntime["getCapabilities"]>>[0],
  ): Promise<AcpRuntimeCapabilities> {
    const capabilities = await this.delegate.getCapabilities(
      input?.handle ? toAcpxResourceInput({ handle: input.handle }) : input,
    );
    return {
      ...capabilities,
      // Core exposes model control through config options.
      controls: capabilities.controls.filter((control) => control !== "session/set_model"),
    };
  }

  async getStatus(
    input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0],
  ): Promise<AcpRuntimeStatus> {
    return this.runWithOperationSnapshot(input.handle, (snapshot) =>
      this.resolveDelegateForOperationSnapshot(input.handle, snapshot).getStatus(
        toAcpxResourceInput(input),
      ),
    );
  }

  async setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    await this.runWithOperationSnapshot(input.handle, (snapshot) =>
      this.resolveDelegateForOperationSnapshot(input.handle, snapshot).setMode(
        toAcpxResourceInput(input),
      ),
    );
  }

  async setConfigOption(
    input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
  ): ReturnType<NonNullable<AcpRuntime["setConfigOption"]>> {
    return await this.runWithOperationSnapshot(input.handle, (snapshot) =>
      this.setConfigOptionUnlocked(input, snapshot),
    );
  }

  private async setConfigOptionUnlocked(
    logicalInput: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
    snapshot: AcpxHandleOperationSnapshot,
  ): ReturnType<NonNullable<AcpRuntime["setConfigOption"]>> {
    const { command } = snapshot;
    const delegate = this.resolveDelegateForOperationSnapshot(logicalInput.handle, snapshot);
    const input = toAcpxResourceInput(logicalInput);
    const key = input.key.trim().toLowerCase();
    const isCodexAcp = isCodexAcpCommand(command);
    if (WIRE_TIMEOUT_CONFIG_KEYS.has(key) && (isCodexAcp || isClaudeAcpCommand(command))) {
      return;
    }
    if (isCodexAcp) {
      if (key === "model") {
        const classification = classifyCodexAcpModelRequest(input.value);
        if (classification.kind === "unsupported") {
          failUnsupportedCodexAcpModel(input.value);
        }
        const { override } = classification;
        const modelResult = override.model
          ? await delegate.setConfigOption({ ...input, key: "model", value: override.model })
          : undefined;
        this.generationRegistry.assertCurrentGeneration(snapshot.generation);
        if (override.reasoningEffort) {
          return await delegate.setConfigOption({
            ...input,
            key: "reasoning_effort",
            value: override.reasoningEffort,
          });
        }
        return modelResult;
      }
      if (key === "thinking" || key === "thought_level" || key === "reasoning_effort") {
        const classification = classifyCodexAcpModelRequest(undefined, input.value);
        const reasoningEffort =
          classification.kind === "override" ? classification.override.reasoningEffort : undefined;
        if (!reasoningEffort) {
          // `off` omits the startup override; Codex has no live control to unset effort.
          throw new AcpRuntimeError(
            "ACP_BACKEND_UNSUPPORTED_CONTROL",
            "Clearing Codex reasoning effort on an existing session is unsupported. Choose a supported explicit effort; the current effort is unchanged.",
          );
        }
        return await delegate.setConfigOption({
          ...input,
          key: "reasoning_effort",
          value: reasoningEffort,
        });
      }
    }
    if (isClaudeAcpCommand(command) && key === "model") {
      return await delegate.setConfigOption({
        ...input,
        value: normalizeClaudeAcpModelOverride(input.value) ?? input.value,
      });
    }
    return await delegate.setConfigOption(input);
  }

  async cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    await this.runWithOperationSnapshot(input.handle, (snapshot) =>
      this.resolveDelegateForOperationSnapshot(input.handle, snapshot).cancel(
        toAcpxResourceInput(input),
      ),
    );
  }

  async prepareFreshSession(
    input: Parameters<NonNullable<AcpRuntime["prepareFreshSession"]>>[0],
  ): Promise<void> {
    // Reset detaches the old lane immediately. Admitted operations retain its
    // cleanup custody until they settle; the successor owns an independent lane.
    const resource = assertAcpxSessionOwnerLocator(input, this.legacyBareSessionKeys);
    this.generationRegistry.prepareFresh(resource);
    // The validated reset retires this startup record before metadata is cleared.
    this.legacyBareSessionKeys.delete(resource);
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    const generation = this.generationForHandle(input.handle);
    // Snapshot reads can yield to reset. Retain cleanup custody before the first
    // await so retirement cannot shut down this close's private runtime.
    await this.runInGeneration(input.handle, { generation }, async () => {
      const snapshot = await this.loadOperationSnapshotForHandle(input.handle, generation, true);
      const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
      await acpxOperationScope.run({ generation, closeRecord: snapshot.record }, async () => {
        // Detach before a destructive backend close can stall. Only the captured
        // generation owns its cleanup; it cannot overwrite a successor.
        if (
          input.discardPersistentState &&
          decodeAcpxRuntimeHandleState(input.handle.runtimeSessionName)?.mode !== "oneshot"
        ) {
          this.generationRegistry.retireGeneration(generation);
          this.legacyBareSessionKeys.delete(generation.resource);
        }
        // Freeze physical cleanup ownership before close can yield or mutate its
        // record. Preparation failures must not prevent the backend close attempt.
        const cleanup = await prepareAcpxProcessCleanup({
          record: snapshot.record,
          command: snapshot.command,
          sessionKey: resolveAcpxSessionResource(input.handle),
          gatewayInstanceId: this.gatewayInstanceId,
          wrapperRoot: this.wrapperRoot,
          leaseStore: this.processLeaseStore,
          deps: this.processCleanupDeps,
        }).catch((error: unknown) => async () => {
          throw error;
        });
        try {
          await delegate.close(toAcpxResourceInput(input));
        } finally {
          await cleanup();
        }
        // Oneshot sessions can share the logical key without sharing physical
        // records. Closing one handle cannot retire another record's live lane.
        const recordId =
          snapshot.record?.acpxRecordId ?? input.handle.acpxRecordId ?? generation.resource;
        const currentRecord = generation.records.get(recordId);
        if (
          !currentRecord ||
          (currentRecord.acpSessionId === snapshot.record?.acpSessionId &&
            currentRecord.createdAt === snapshot.record?.createdAt)
        ) {
          generation.records.delete(recordId);
          if (generation.activeRecordOperations.has(recordId)) {
            generation.closedRecordIds.add(recordId);
          }
        }
        generation.closeCompleted = true;
      });
    });
  }
}

export {
  ACPX_BACKEND_ID,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
};

/** Test-only hooks for ACPX runtime behavior that is otherwise private. */
export const testing = {
  appendCodexAcpConfigOverrides,
  isClaudeAcpCommand,
  isCodexAcpCommand,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
