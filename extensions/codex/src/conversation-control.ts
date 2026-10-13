import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyModelOverrideWithAuthProfileCompatibility,
  ModelSelectionLockedError,
} from "openclaw/plugin-sdk/model-session-runtime";
import {
  getSessionEntryAsync,
  prepareSessionEntryPatch,
  resolveStorePath,
  type SessionEntrySourceAuthority,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  type CodexAppServerAuthProfileLookup,
} from "./app-server/auth-profile.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import { isCodexFastServiceTier } from "./app-server/config.js";
import type { CodexServiceTier } from "./app-server/protocol.js";
import {
  bindingStoreKey,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import {
  resolveCodexAppServerRequestModelSelection,
  resolveCodexBindingModelProviderFallback,
} from "./app-server/thread-model-selection.js";
import { formatCodexDisplayText } from "./command-formatters.js";

type ActiveTurn = {
  identity: CodexAppServerBindingIdentity;
  client: CodexAppServerClient;
  requestTimeoutMs: number;
  threadId: string;
  turnId: string;
};

type CodexAppServerBindingLookup = Omit<CodexAppServerAuthProfileLookup, "authProfileId">;

type PermissionsMode = "default" | "yolo";

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
  return getActiveTurns().get(bindingStoreKey(identity));
}

export async function stopCodexConversationTurn(params: {
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding | undefined;
  assertCurrent: () => void;
  assertCurrentAsync?: () => Promise<void>;
}): Promise<{ stopped: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.identity);
  if (!active) {
    return { stopped: false, message: "No active Codex run to stop." };
  }
  const binding = params.binding;
  if (binding?.threadId !== active.threadId) {
    return {
      stopped: false,
      message: "The active Codex run no longer matches this session binding.",
    };
  }
  await active.client.request(
    "turn/interrupt",
    { threadId: active.threadId, turnId: active.turnId },
    {
      timeoutMs: active.requestTimeoutMs,
      assertCurrent: params.assertCurrent,
      withCurrent: async (write) => {
        await params.assertCurrentAsync?.();
        params.assertCurrent();
        write();
      },
    },
  );
  return { stopped: true, message: "Codex stop requested." };
}

export async function steerCodexConversationTurn(params: {
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding | undefined;
  message: string;
  assertCurrent: () => void;
  assertCurrentAsync?: () => Promise<void>;
}): Promise<{ steered: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.identity);
  const text = params.message.trim();
  if (!text) {
    return { steered: false, message: "Usage: /codex steer <message>" };
  }
  if (!active) {
    return { steered: false, message: "No active Codex run to steer." };
  }
  const binding = params.binding;
  if (binding?.threadId !== active.threadId) {
    return {
      steered: false,
      message: "The active Codex run no longer matches this session binding.",
    };
  }
  await active.client.request(
    "turn/steer",
    {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    },
    {
      timeoutMs: active.requestTimeoutMs,
      assertCurrent: params.assertCurrent,
      withCurrent: async (write) => {
        await params.assertCurrentAsync?.();
        params.assertCurrent();
        write();
      },
    },
  );
  return { steered: true, message: "Sent steer message to Codex." };
}

export async function setCodexConversationModel(input: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  binding: CodexAppServerThreadBinding | undefined;
  model: string;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
  storePath?: string;
  assertCurrent: () => void;
  assertCurrentAsync?: () => Promise<void>;
  assertCommitAllowed?: SessionEntrySourceAuthority;
}): Promise<string> {
  const params = { ...input };
  await params.assertCurrentAsync?.();
  const model = params.model.trim();
  if (!model) {
    return "Usage: /codex model <model>";
  }
  const lookup = buildCodexConversationAgentLookup(params);
  params.assertCurrent();
  const assertCommitAllowed = params.assertCommitAllowed ?? params.assertCurrent;
  const binding = requirePreparedThreadBinding(params.binding);
  if (binding.connectionScope === "supervision") {
    throw new ModelSelectionLockedError();
  }
  const modelProvider = await resolveThreadRequestModelProvider({
    authProfileId: binding.authProfileId,
    modelProvider: resolveCodexBindingModelProviderFallback({
      bindingModel: binding.model,
      bindingModelProvider: binding.modelProvider,
      currentModel: model,
    }),
    ...lookup,
  });
  const modelSelection = await resolveCodexAppServerRequestModelSelection({
    model,
    modelProvider,
    authProfileId: binding.authProfileId,
    ...lookup,
  });
  const nextModelProvider = await normalizeCodexAppServerBindingModelProvider({
    authProfileId: binding.authProfileId,
    modelProvider: modelSelection.modelProvider,
    ...lookup,
  });
  const nextModel = modelSelection.model;
  const modelChanged = nextModel !== binding.model || nextModelProvider !== binding.modelProvider;
  const projectionPatch =
    modelChanged && binding.contextEngine?.projection
      ? { contextEngine: { ...binding.contextEngine, projection: undefined } }
      : {};
  const identity = params.identity;
  if (identity.kind === "session" && identity.sessionKey) {
    // SessionEntry owns the desired model; retain the loaded binding until
    // lifecycle reconciliation can rotate its native generation safely.
    const updated = await prepareSessionEntryPatch({
      agentId: identity.agentId,
      storePath:
        params.storePath ??
        resolveStorePath(params.config?.session?.store, { agentId: identity.agentId }),
      sessionKey: identity.sessionKey,
      requireWriteSuccess: true,
      replaceEntry: true,
      authority: params.assertCommitAllowed
        ? { kind: "source", source: params.assertCommitAllowed }
        : { kind: "host", assertCurrent: params.assertCurrent },
      prepare: (entry) => {
        if (entry.sessionId !== identity.sessionId) {
          throw new Error("Codex session changed while applying the model selection.");
        }
        applyModelOverrideWithAuthProfileCompatibility({
          cfg: params.config ?? {},
          agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, identity.agentId),
          entry,
          currentProvider: binding.modelProvider ?? "openai",
          selection: { provider: nextModelProvider ?? "openai", model: nextModel },
          markLiveSwitchPending: true,
        });
        return entry;
      },
    });
    if (!updated) {
      throw new Error("Codex session changed while applying the model selection.");
    }
    if (modelChanged && binding.contextEngine?.projection) {
      await patchThreadBinding(
        params.bindingStore,
        identity,
        binding.threadId,
        projectionPatch,
        params.assertCurrent,
      );
    }
  } else {
    // Conversation bindings and ephemeral sessions own native selection;
    // ambient outer-session metadata must never redirect their runtime.
    await patchThreadBinding(
      params.bindingStore,
      params.identity,
      binding.threadId,
      {
        model: nextModel,
        modelProvider: nextModelProvider,
        ...projectionPatch,
      },
      assertCommitAllowed,
    );
  }
  return `Codex model set to ${formatCodexDisplayText(nextModel)}.`;
}

export async function setCodexConversationFastMode(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  binding: CodexAppServerThreadBinding | undefined;
  enabled?: boolean;
  assertCurrent: () => void;
}): Promise<string> {
  params.assertCurrent();
  const binding = requirePreparedThreadBinding(params.binding);
  if (params.enabled == null) {
    return `Codex fast mode: ${isCodexFastServiceTier(binding.serviceTier) ? "on" : "off"}.`;
  }
  const serviceTier: CodexServiceTier = params.enabled ? "priority" : "flex";
  // Fast mode is sent on each later turn; do not require Codex to accept an
  // immediate thread/resume control request just to persist the preference.
  await patchThreadBinding(
    params.bindingStore,
    params.identity,
    binding.threadId,
    { serviceTier },
    params.assertCurrent,
  );
  return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
}

export async function setCodexConversationPermissions(params: {
  mode?: PermissionsMode;
  config?: CodexAppServerBindingLookup["config"];
  storePath?: string;
  assertCurrent: () => void;
  sourceAuthority?: SessionEntrySourceAuthority;
  session: { agentId: string; sessionId: string; sessionKey: string };
}): Promise<string> {
  params.assertCurrent();
  const storePath =
    params.storePath ??
    resolveStorePath(params.config?.session?.store, {
      agentId: params.session.agentId,
    });
  if (!params.mode) {
    const entry = await getSessionEntryAsync({
      agentId: params.session.agentId,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
      sessionKey: params.session.sessionKey,
      storePath,
    });
    params.assertCurrent();
    if (entry?.sessionId !== params.session.sessionId) {
      throw new Error("Codex session changed while reading the permission mode.");
    }
    return `Codex permissions: ${formatPermissionsMode(entry.permissionMode)}.`;
  }
  const updated = await prepareSessionEntryPatch({
    agentId: params.session.agentId,
    storePath,
    sessionKey: params.session.sessionKey,
    requireWriteSuccess: true,
    replaceEntry: true,
    authority: params.sourceAuthority
      ? { kind: "source", source: params.sourceAuthority }
      : { kind: "host", assertCurrent: params.assertCurrent },
    prepare: (entry) => {
      if (entry.sessionId !== params.session.sessionId) {
        throw new Error("Codex session changed while applying the permission mode.");
      }
      entry.permissionMode = params.mode === "yolo" ? "full" : "guarded";
      return entry;
    },
  });
  if (!updated) {
    throw new Error("Codex session changed while applying the permission mode.");
  }
  return `Codex permissions set to ${params.mode === "yolo" ? "full access" : "guarded"}.`;
}

export function parseCodexFastModeArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "fast") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "flex") {
    return false;
  }
  return undefined;
}

export function parseCodexPermissionsModeArg(arg: string | undefined): PermissionsMode | undefined {
  const normalized = arg?.trim().toLowerCase() ?? "";
  if (normalized === "yolo" || normalized === "full" || normalized === "full-access") {
    return "yolo";
  }
  if (["default", "guardian", "guarded", "approve"].includes(normalized)) {
    return "default";
  }
  return undefined;
}

export function formatPermissionsMode(
  mode: "read-only" | "guarded" | "workspace" | "full" | undefined,
): string {
  return mode === "full" ? "full access" : (mode ?? "default");
}

function requirePreparedThreadBinding(binding: CodexAppServerThreadBinding | undefined) {
  if (!binding?.threadId) {
    throw new Error("No Codex thread is attached to this OpenClaw session yet.");
  }
  return binding;
}

async function patchThreadBinding(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  threadId: string,
  patch: Extract<Parameters<CodexAppServerBindingStore["mutate"]>[1], { kind: "patch" }>["patch"],
  assertCurrent: () => void,
): Promise<void> {
  if (!(await bindingStore.mutate(identity, { kind: "patch", threadId, patch }, assertCurrent))) {
    throw new Error("Codex thread binding changed while applying the control update.");
  }
}

export function buildCodexConversationAgentLookup(params: {
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): CodexAppServerBindingLookup {
  const agentDir = params.agentDir?.trim();
  return {
    ...(agentDir ? { agentDir } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
}

export async function resolveThreadRequestModelProvider(
  params: CodexAppServerAuthProfileLookup & { modelProvider?: string },
): Promise<string | undefined> {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider || modelProvider.toLowerCase() === "codex") {
    return undefined;
  }
  if (
    modelProvider.toLowerCase() === "openai" &&
    (await isCodexAppServerNativeAuthProfile(params))
  ) {
    return undefined;
  }
  return modelProvider.toLowerCase() === "openai" ? "openai" : modelProvider;
}
