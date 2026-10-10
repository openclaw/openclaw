/** Generation-aware binding reads and ownership checks over the canonical persisted codec. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  codexNativeSubagentHistoryConnectionFingerprint,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import {
  matchesNativeAssignmentLifecycle,
  readNativePendingAssignments,
  type CodexNativeSubagentPendingAssignment,
} from "./native-subagent-pending-assignments.js";
import {
  matchesCodexNativeSubagentSubmissionOwner,
  readCodexNativeSubagentSubmissions,
  type CodexNativeSubagentSubmission,
} from "./native-subagent-submission.js";
import {
  legacyAppPolicyEntrySchema,
  readStoredCodexAppServerBinding,
  type CodexAppServerThreadBinding,
  type PluginAppPolicyContext,
  type StoredCodexAppServerBinding,
} from "./session-binding-record-codec.js";

export {
  matchesPendingSupervisionBranch,
  readCodexAppServerThreadBinding,
  readCodexBindingTimestamp,
  readStoredCodexAppServerBinding,
  stripUndefinedBinding,
  validateBindingForWrite,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerContextEngineProjectionBinding,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding-record-codec.js";

/** Stable owner of one Codex thread binding. */
export type CodexAppServerBindingIdentity =
  | { kind: "session"; agentId: string; sessionId: string; sessionKey?: string }
  | { kind: "conversation"; bindingId: string };

/** Resolves the same agent scope OpenClaw uses for transcript/session ownership. */
export function sessionBindingIdentity(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Extract<CodexAppServerBindingIdentity, { kind: "session" }> {
  const { sessionAgentId } = resolveSessionAgentIdsStrict(params);
  const sessionKey = params.sessionKey?.trim();
  return {
    kind: "session",
    agentId: sessionAgentId,
    sessionId: params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/** Stable plugin-state key for one current binding owner. */
export function bindingStoreKey(identity: CodexAppServerBindingIdentity): string {
  if (identity.kind === "session") {
    const rawAgentId = identity.agentId.trim();
    const sessionId = identity.sessionId.trim();
    if (!rawAgentId) {
      throw new Error("Codex app-server binding requires an agent id");
    }
    if (!sessionId) {
      throw new Error("Codex app-server binding requires a session id");
    }
    const agentId = resolveSessionAgentIdsStrict({ agentId: rawAgentId }).sessionAgentId;
    const sessionKey = identity.sessionKey?.trim();
    if (sessionKey) {
      const digest = createHash("sha256").update(sessionKey).digest("base64url");
      return `session-key:${agentId}:${digest}`;
    }
    return `session:${agentId}:${sessionId}`;
  }
  const bindingId = identity.bindingId.trim();
  if (!bindingId) {
    throw new Error("Codex app-server conversation binding requires a binding id");
  }
  return `conversation:${bindingId}`;
}

export function ownsStoredSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): boolean {
  return (
    identity.kind !== "session" || !current?.sessionId || current.sessionId === identity.sessionId
  );
}

/** Final effect guards retain the live row until raw SDK binding writers retire. */
export function readCurrentCodexAppServerBinding(
  state: Pick<PluginStateSyncKeyedStore<StoredCodexAppServerBinding>, "lookup">,
  identity: CodexAppServerBindingIdentity,
): CodexAppServerThreadBinding | undefined {
  const key = bindingStoreKey(identity);
  return decodeCurrentCodexAppServerBinding(key, state.lookup(key), identity);
}

export async function readCurrentCodexAppServerBindingAsync(
  state: Pick<PluginStateKeyedStore<StoredCodexAppServerBinding>, "lookup">,
  identity: CodexAppServerBindingIdentity,
): Promise<CodexAppServerThreadBinding | undefined> {
  const key = bindingStoreKey(identity);
  return decodeCurrentCodexAppServerBinding(key, await state.lookup(key), identity);
}

function decodeCurrentCodexAppServerBinding(
  key: string,
  raw: unknown,
  identity: CodexAppServerBindingIdentity,
): CodexAppServerThreadBinding | undefined {
  const stored = readStoredCodexAppServerBinding(raw);
  if (raw !== undefined && !stored) {
    throw new Error(`Invalid Codex app-server binding row: ${key}`);
  }
  return stored?.state === "active" && ownsStoredSessionGeneration(identity, stored)
    ? stored.binding
    : undefined;
}

/** Acquire fresh rows off-thread; decode lazily to preserve caller failure ordering. */
export async function* readCurrentCodexAppServerBindings(
  state: Pick<PluginStateKeyedStore<StoredCodexAppServerBinding>, "lookup" | "lookupMany">,
  identities: readonly CodexAppServerBindingIdentity[],
): AsyncGenerator<CodexAppServerThreadBinding | undefined, undefined, void> {
  const lookupMany = state.lookupMany?.bind(state);
  for (let offset = 0; offset < identities.length; offset += 10_000) {
    const batch = identities.slice(offset, offset + 10_000);
    let keys: string[] | undefined;
    if (lookupMany) {
      try {
        keys = batch.map(bindingStoreKey);
      } catch {
        // A later invalid identity must not precede an earlier row's validation.
      }
    }
    if (!keys || !lookupMany) {
      for (const identity of batch) {
        const key = bindingStoreKey(identity);
        yield decodeCurrentCodexAppServerBinding(key, await state.lookup(key), identity);
      }
      continue;
    }
    // Query failures retain the storage owner's terminal handling; never retry the read.
    const values = await lookupMany(keys);
    for (let index = 0; index < batch.length; index++) {
      const value = values[index]!;
      if (!value.ok) {
        throw value.error;
      }
      yield decodeCurrentCodexAppServerBinding(keys[index]!, value.value, batch[index]!);
    }
  }
}

export function matchesCodexNativeSubagentSubmissionBinding(
  binding: CodexAppServerThreadBinding,
  owner: CodexNativeSubagentHistoryOwner,
): boolean {
  return (
    binding.threadId === owner.parentThreadId &&
    !binding.pendingSupervisionBranch &&
    codexNativeSubagentHistoryConnectionFingerprint(binding) === owner.connectionFingerprint
  );
}

/** Unknown metadata stays opaque through ordinary binding writes. */
export function preserveCodexNativeSubagentSubmissions(
  currentBinding: CodexAppServerThreadBinding,
  nextBinding: CodexAppServerThreadBinding,
  value: unknown,
): unknown {
  return currentBinding.threadId === nextBinding.threadId
    ? preserveNativePendingAssignments(currentBinding, nextBinding, value)
    : undefined;
}

export async function readCurrentCodexNativeSubagentSubmissions(
  state: Pick<PluginStateKeyedStore<StoredCodexAppServerBinding>, "lookup">,
  identity: CodexAppServerBindingIdentity,
  owner: CodexNativeSubagentHistoryOwner,
): Promise<readonly CodexNativeSubagentSubmission[]> {
  const stored = await readCurrentNativeSubagentBinding(state, identity, owner);
  if (!stored) {
    return [];
  }
  const submissions = readCodexNativeSubagentSubmissions(stored.nativeSubagentSubmissions);
  return submissions && matchesCodexNativeSubagentSubmissionOwner(submissions.owner, owner)
    ? submissions.receipts
    : [];
}

export async function readCurrentNativePendingAssignments(
  state: Pick<PluginStateKeyedStore<StoredCodexAppServerBinding>, "lookup">,
  identity: CodexAppServerBindingIdentity,
  owner: CodexNativeSubagentHistoryOwner,
): Promise<readonly CodexNativeSubagentPendingAssignment[]> {
  const stored = await readCurrentNativeSubagentBinding(state, identity, owner);
  return (
    readNativePendingAssignments(stored?.nativeSubagentAssignments)?.assignments ?? []
  ).filter((entry) => matchesNativeAssignmentLifecycle(entry.owner, owner));
}

async function readCurrentNativeSubagentBinding(
  state: Pick<PluginStateKeyedStore<StoredCodexAppServerBinding>, "lookup">,
  identity: CodexAppServerBindingIdentity,
  owner: CodexNativeSubagentHistoryOwner,
): Promise<Extract<StoredCodexAppServerBinding, { state: "active" }> | undefined> {
  const key = bindingStoreKey(identity);
  const raw = await state.lookup(key);
  const stored = readStoredCodexAppServerBinding(raw);
  if (raw !== undefined && !stored) {
    throw new Error(`Invalid Codex app-server binding row: ${key}`);
  }
  if (
    stored?.state !== "active" ||
    !ownsStoredSessionGeneration(identity, stored) ||
    (identity.kind === "session" && owner.sessionId !== identity.sessionId) ||
    !matchesCodexNativeSubagentSubmissionBinding(stored.binding, owner)
  ) {
    return undefined;
  }
  return stored;
}

export function preserveNativeTaskImport(current: StoredCodexAppServerBinding | undefined) {
  return current?.nativeSubagentTaskImport !== undefined
    ? { nativeSubagentTaskImport: current.nativeSubagentTaskImport }
    : {};
}

/** Preserve inventory through native rotation, never across a connection-policy change. */
export function preserveNativePendingAssignments(
  current: CodexAppServerThreadBinding,
  next: CodexAppServerThreadBinding,
  value: unknown,
): unknown {
  return codexNativeSubagentHistoryConnectionFingerprint(current) ===
    codexNativeSubagentHistoryConnectionFingerprint(next) &&
    isDeepStrictEqual(current.pendingSupervisionBranch, next.pendingSupervisionBranch)
    ? value
    : undefined;
}

export class CodexSupervisionBindingReplacementError extends Error {
  constructor(threadId: string, operation: string) {
    super(
      `Refusing to replace supervised Codex thread ${threadId} while ${operation}; ` +
        "its native user-home connection and model ownership must be preserved",
    );
    this.name = "CodexSupervisionBindingReplacementError";
  }
}

export function assertCodexBindingMayBeReplaced(
  binding: CodexAppServerThreadBinding | undefined,
  operation: string,
  expected?: EmbeddedRunAttemptParamsV2["expectedSessionRuntimeOwnership"],
): void {
  // A native-prepared attempt has no host-selected model for a replacement thread.
  if (expected) {
    throw new AgentHarnessPreflightError(
      `Codex native model ownership prevents ${operation}. Continue or compact the original session in its native runtime, or create a new chat with a concrete model; the original binding was preserved.`,
    );
  }
  if (binding?.connectionScope === "supervision") {
    throw new CodexSupervisionBindingReplacementError(binding.threadId, operation);
  }
}

export function readPluginAppPolicyContext(value: unknown): PluginAppPolicyContext | undefined {
  const record = asOptionalRecord(value);
  if (!record || typeof record.fingerprint !== "string") {
    return undefined;
  }
  const apps = asOptionalRecord(record.apps);
  if (!apps) {
    return undefined;
  }
  const parsedApps: PluginAppPolicyContext["apps"] = {};
  for (const [appId, rawEntry] of Object.entries(apps)) {
    const entry = asOptionalRecord(rawEntry);
    if (!entry || "appId" in entry) {
      return undefined;
    }
    const parsed = legacyAppPolicyEntrySchema.safeParse(entry);
    if (!parsed.success) {
      return undefined;
    }
    const validated = parsed.data;
    const { destructiveApprovalMode } = validated;
    const policy = {
      allowDestructiveActions: validated.allowDestructiveActions,
      ...(validated.allowOpenWorld !== undefined
        ? { allowOpenWorld: validated.allowOpenWorld }
        : {}),
      ...(destructiveApprovalMode ? { destructiveApprovalMode } : {}),
      mcpServerNames: validated.mcpServerNames,
    };
    if (validated.source === "account") {
      parsedApps[appId] = { source: "account", appName: validated.appName, ...policy };
    } else {
      parsedApps[appId] = {
        configKey: validated.configKey,
        marketplaceName: validated.marketplaceName,
        pluginName: validated.pluginName,
        ...policy,
      };
    }
  }
  const parsedPluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  const pluginAppIds =
    record.pluginAppIds === undefined ? {} : asOptionalRecord(record.pluginAppIds);
  if (!pluginAppIds) {
    return undefined;
  }
  for (const [configKey, appIds] of Object.entries(pluginAppIds)) {
    if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) {
      return undefined;
    }
    parsedPluginAppIds[configKey] = appIds;
  }
  return {
    fingerprint: record.fingerprint,
    apps: parsedApps,
    pluginAppIds: parsedPluginAppIds,
  };
}

export function storedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): { sessionId?: string } {
  if (identity.kind === "session") {
    return { sessionId: identity.sessionId };
  }
  return current?.sessionId ? { sessionId: current.sessionId } : {};
}

export function preservedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): { sessionId?: string } {
  if (current?.sessionId) {
    return { sessionId: current.sessionId };
  }
  return storedSessionGeneration(identity, current);
}
