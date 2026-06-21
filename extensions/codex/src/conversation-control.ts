import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  isCodexAppServerUnsafeSubscriptionError,
  settleCodexAppServerClientLease,
} from "./app-server/attempt-client-cleanup.js";
// Codex plugin module implements conversation control behavior.
import {
  isCodexFastServiceTier,
  resolveCodexAppServerRuntime,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexModelBackedReviewerPolicyContext,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./app-server/config.js";
import type { CodexServiceTier, CodexThreadResumeResponse } from "./app-server/protocol.js";
import {
  bindingStoreKey,
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import { leaseSharedCodexAppServerClient } from "./app-server/shared-client.js";
import {
  resolveCodexAppServerRequestModelSelection,
  resolveCodexBindingModelProviderFallback,
} from "./app-server/thread-lifecycle.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import { formatCodexDisplayText } from "./command-formatters.js";

type ActiveTurn = {
  identity: CodexAppServerBindingIdentity;
  threadId: string;
  turnId: string;
  interrupt: () => Promise<void>;
  steer: (message: string) => Promise<void>;
};

type CodexAppServerBindingLookup = Omit<CodexAppServerAuthProfileLookup, "authProfileId">;
type CodexAppServerBindingPatch = Extract<
  Parameters<CodexAppServerBindingStore["mutate"]>[1],
  { kind: "patch" }
>["patch"];

type PermissionsMode = "default" | "yolo";

const activeTurns = new Map<string, ActiveTurn>();

export function trackCodexConversationActiveTurn(active: ActiveTurn): () => void {
  const key = bindingStoreKey(active.identity);
  activeTurns.set(key, active);
  return () => {
    const current = activeTurns.get(key);
    if (current?.turnId === active.turnId) {
      activeTurns.delete(key);
    }
  };
}

export function readCodexConversationActiveTurn(
  identity: CodexAppServerBindingIdentity,
): ActiveTurn | undefined {
  return activeTurns.get(bindingStoreKey(identity));
}

export async function stopCodexConversationTurn(params: {
  identity: CodexAppServerBindingIdentity;
}): Promise<{ stopped: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.identity);
  if (!active) {
    return { stopped: false, message: "No active Codex run to stop." };
  }
  await active.interrupt();
  return { stopped: true, message: "Codex stop requested." };
}

export async function steerCodexConversationTurn(params: {
  identity: CodexAppServerBindingIdentity;
  message: string;
}): Promise<{ steered: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.identity);
  const text = params.message.trim();
  if (!text) {
    return { steered: false, message: "Usage: /codex steer <message>" };
  }
  if (!active) {
    return { steered: false, message: "No active Codex run to steer." };
  }
  await active.steer(text);
  return { steered: true, message: "Sent steer message to Codex." };
}

export async function setCodexConversationModel(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  model: string;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const model = params.model.trim();
  if (!model) {
    return "Usage: /codex model <model>";
  }
  return await params.bindingStore.withLease(params.identity, async () => {
    const lookup = buildBindingLookup(params);
    const binding = await requireThreadBinding(params.bindingStore, params.identity);
    const reviewerPolicyContext = resolveCodexModelBackedReviewerPolicyContext({
      provider: "codex",
      model,
      bindingModelProvider: binding.modelProvider,
      bindingModel: binding.model,
    });
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: params.pluginConfig,
      modelProvider: reviewerPolicyContext.modelProvider,
      model: reviewerPolicyContext.model,
      config: params.config,
      agentDir: params.agentDir,
    });
    const modelProvider = resolveConversationControlModelProvider({
      authProfileId: binding.authProfileId,
      bindingModel: binding.model,
      bindingModelProvider: binding.modelProvider,
      currentModel: model,
      ...lookup,
    });
    const modelSelection = resolveCodexAppServerRequestModelSelection({
      model,
      modelProvider,
      authProfileId: binding.authProfileId,
      ...lookup,
    });
    const response = await resumeThreadWithOverrides({
      runtime,
      threadId: binding.threadId,
      authProfileId: binding.authProfileId,
      ...lookup,
      model: modelSelection.model,
      modelProvider: modelSelection.modelProvider,
    });
    const nextModel = response.model;
    const activeReviewerContext = resolveCodexModelBackedReviewerPolicyContext({
      provider: response.modelProvider,
      model: nextModel,
    });
    const activeRuntime = resolveCodexAppServerRuntime({
      pluginConfig: params.pluginConfig,
      modelProvider: activeReviewerContext.modelProvider,
      model: activeReviewerContext.model,
      config: params.config,
      agentDir: params.agentDir,
    });
    const useActivePolicy = !activeRuntime.modelBackedReviewerAvailable;
    const activeApprovalPolicy =
      typeof activeRuntime.appServer.approvalPolicy === "string"
        ? activeRuntime.appServer.approvalPolicy
        : undefined;
    const nextModelProvider = normalizeCodexAppServerBindingModelProvider({
      authProfileId: binding.authProfileId,
      modelProvider: response.modelProvider,
      ...lookup,
    });
    const modelChanged = nextModel !== binding.model || nextModelProvider !== binding.modelProvider;
    await patchThreadBinding({
      bindingStore: params.bindingStore,
      identity: params.identity,
      threadId: binding.threadId,
      patch: {
        cwd: response.thread.cwd ?? binding.cwd,
        model: nextModel,
        modelProvider: nextModelProvider,
        ...(modelChanged
          ? {
              nativeContextUsage: undefined,
              modelContextWindow: undefined,
            }
          : {}),
        approvalPolicy: useActivePolicy ? activeApprovalPolicy : binding.approvalPolicy,
        sandbox: useActivePolicy ? activeRuntime.appServer.sandbox : binding.sandbox,
        serviceTier: binding.serviceTier ?? activeRuntime.appServer.serviceTier,
      },
    });
    return `Codex model set to ${formatCodexDisplayText(response.model)}.`;
  });
}

export async function setCodexConversationFastMode(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  enabled?: boolean;
}): Promise<string> {
  if (params.enabled == null) {
    const binding = await requireThreadBinding(params.bindingStore, params.identity);
    return `Codex fast mode: ${isCodexFastServiceTier(binding.serviceTier) ? "on" : "off"}.`;
  }
  return await params.bindingStore.withLease(params.identity, async () => {
    const binding = await requireThreadBinding(params.bindingStore, params.identity);
    const serviceTier: CodexServiceTier = params.enabled ? "priority" : "flex";
    // Fast mode is sent on each later turn; do not require Codex to accept an
    // immediate thread/resume control request just to persist the preference.
    await patchThreadBinding({
      bindingStore: params.bindingStore,
      identity: params.identity,
      threadId: binding.threadId,
      patch: { serviceTier },
    });
    return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
  });
}

export async function setCodexConversationPermissions(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  mode?: PermissionsMode;
}): Promise<string> {
  const mode = params.mode;
  if (!mode) {
    const binding = await requireThreadBinding(params.bindingStore, params.identity);
    return `Codex permissions: ${formatPermissionsMode(binding)}.`;
  }
  return await params.bindingStore.withLease(params.identity, async () => {
    const binding = await requireThreadBinding(params.bindingStore, params.identity);
    const policy = permissionsForMode(mode);
    // Native bound turns pass these settings at turn/start time, so this command
    // can update the local binding even when app-server resume overrides fail.
    await patchThreadBinding({
      bindingStore: params.bindingStore,
      identity: params.identity,
      threadId: binding.threadId,
      patch: policy,
    });
    return `Codex permissions set to ${mode === "yolo" ? "full access" : "default"}.`;
  });
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

export function formatPermissionsMode(binding: {
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
}): string {
  return binding.approvalPolicy === "never" && binding.sandbox === "danger-full-access"
    ? "full access"
    : "default";
}

async function requireThreadBinding(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
) {
  const binding = await bindingStore.read(identity);
  if (!binding?.threadId) {
    throw new Error("No Codex thread is attached to this OpenClaw session yet.");
  }
  return binding;
}

async function patchThreadBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  threadId: string;
  patch: CodexAppServerBindingPatch;
}): Promise<void> {
  const updated = await params.bindingStore.mutate(params.identity, {
    kind: "patch",
    threadId: params.threadId,
    patch: params.patch,
  });
  if (!updated) {
    throw new Error("Codex thread binding changed while applying the control update.");
  }
}

async function resumeThreadWithOverrides(params: {
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
  threadId: string;
  authProfileId?: string;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
}): Promise<CodexThreadResumeResponse> {
  const runtime = params.runtime;
  const clientLease = await leaseSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...buildBindingLookup(params),
  });
  const client = clientLease.client;
  let abandonClient = false;
  try {
    return await resumeCodexAppServerThread({
      client,
      abandonClient: clientLease.abandon,
      request: {
        threadId: params.threadId,
        ...(params.model ? { model: params.model } : {}),
        ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
        approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
        sandbox: params.sandbox ?? runtime.sandbox,
        approvalsReviewer: runtime.approvalsReviewer,
        ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
        excludeTurns: true,
        persistExtendedHistory: true,
      },
      timeoutMs: runtime.requestTimeoutMs,
    });
  } catch (error) {
    abandonClient = isCodexAppServerUnsafeSubscriptionError(error);
    throw error;
  } finally {
    await settleCodexAppServerClientLease(clientLease, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      abandon: abandonClient,
    });
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

function resolveConversationControlModelProvider(params: {
  authProfileId?: string;
  bindingModel?: string;
  bindingModelProvider?: string;
  currentModel?: string;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): string | undefined {
  const modelProvider = resolveCodexBindingModelProviderFallback({
    currentModel: params.currentModel,
    bindingModel: params.bindingModel,
    bindingModelProvider: params.bindingModelProvider,
  })?.trim();
  if (!modelProvider || modelProvider.toLowerCase() === "codex") {
    return undefined;
  }
  if (isCodexAppServerNativeAuthProfile(params) && modelProvider.toLowerCase() === "openai") {
    return undefined;
  }
  return modelProvider.toLowerCase() === "openai" ? "openai" : modelProvider;
}

function permissionsForMode(mode: PermissionsMode): {
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
} {
  return mode === "yolo"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}
