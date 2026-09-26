/**
 * Sandbox runtime status and tool-policy diagnostics.
 *
 * Resolves whether a session is sandboxed and explains policy blocks before tool execution.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../config/sessions/main-session.js";
import {
  resolveSessionStorePathCore,
  resolveSessionStorePathWithContext,
} from "../../config/sessions/paths.js";
import {
  loadExactSessionEntryCandidatesReadOnlyBatch,
  resolveSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import {
  sessionCreatorProfileId,
  type SessionCreatedActor,
} from "../../config/sessions/session-entry-provenance.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { auditSandboxToolPolicyBlock, escapeControlCharsVisible } from "../tool-policy-audit.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  classifyToolAgainstSandboxToolPolicy,
  resolveSandboxToolPolicyForAgent,
} from "./tool-policy.js";
import type {
  SandboxConfig,
  SandboxIsolationSubject,
  SandboxToolPolicyResolved,
  SandboxWorkspaceAccess,
} from "./types.js";

type SandboxRuntimeIsolation =
  | {
      sandboxRequired: false;
      isolationSubject?: never;
      createdActor?: never;
      workspaceAccess?: never;
    }
  | {
      sandboxRequired: true;
      isolationSubject: SandboxIsolationSubject;
      createdActor?: SessionCreatedActor;
      workspaceAccess: SandboxWorkspaceAccess;
    };

function shouldSandboxSession(
  cfg: SandboxConfig,
  sessionKey: string,
  mainSessionKey: string,
  sandboxRequired: boolean,
  sandboxMode?: SessionEntry["sandboxMode"],
) {
  if (sandboxRequired) {
    return true;
  }
  if (sandboxMode === "off" || cfg.mode === "off") {
    return false;
  }
  if (cfg.mode === "all") {
    return true;
  }
  return sessionKey.trim() !== mainSessionKey.trim();
}

function resolveMainSessionKeyForSandbox(params: {
  cfg?: OpenClawConfig;
  agentId: string;
}): string {
  if (params.cfg?.session?.scope === "global") {
    return "global";
  }
  return resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
}

type SandboxRuntimeStatusParams = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  /** Independent execution identity used for sandbox mode and policy classification. */
  classificationSessionKey?: string;
  classificationAgentId?: string;
  /** Trusted canonical candidate for the classification identity; null means no stored entry. */
  preparedSessionEntry?: Pick<SessionEntry, "sandbox" | "sandboxMode" | "createdActor"> | null;
};

/** Resolves sandbox mode, effective session scope, and tool policy for a session. */
export function resolveSandboxRuntimeStatus(params: SandboxRuntimeStatusParams) {
  return resolveSandboxRuntimeStatusWithRead(params, resolveSessionEntry);
}

/** Keep the classification read's captured owner alive through one asynchronous policy preparation. */
export async function withSandboxRuntimeStatusInWorker<T>(
  params: Omit<SandboxRuntimeStatusParams, "preparedSessionEntry">,
  source: { env: NodeJS.ProcessEnv; cwd: string; assertCurrent: () => void },
  consume: (runtime: ReturnType<typeof resolveSandboxRuntimeStatus>) => Promise<T>,
): Promise<T> {
  source.assertCurrent();
  const classification = resolveSandboxClassification(params);
  const prepare = (entry: SessionEntry | undefined) => {
    source.assertCurrent();
    return consume(
      resolveSandboxRuntimeStatusWithRead(
        { ...params, preparedSessionEntry: entry ?? null },
        resolveSessionEntry,
        classification,
      ),
    );
  };
  if (!classification.classificationSessionKey) {
    const result = await prepare(undefined);
    source.assertCurrent();
    return result;
  }
  return withSessionEntryReadOnlyInWorker(
    {
      agentId: classification.classificationAgentId,
      sessionKey: classification.comparableSessionKey,
      storePath: resolveSessionStorePathWithContext(
        params.cfg?.session?.store,
        {
          agentId: classification.classificationAgentId,
          env: source.env,
        },
        { cwd: source.cwd },
      ),
      env: source.env,
    },
    source.assertCurrent,
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return prepare(read.value);
    },
  );
}

/** Classifies durable canonical keys without admitting the same store once per session. */
export function resolveSandboxRuntimeStatusesForPersistedSessions(
  requests: readonly {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKeys: readonly string[];
    env: NodeJS.ProcessEnv;
  }[],
) {
  const results = loadExactSessionEntryCandidatesReadOnlyBatch(
    requests.map((params) => ({
      agentId: params.agentId,
      env: params.env,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.agentId,
        env: params.env,
      }),
      projection: "list" as const,
      sessionKeys: params.sessionKeys.map((sessionKey) =>
        canonicalizeMainSessionAlias({ ...params, sessionKey }),
      ),
    })),
  );
  return requests.map((params, index) => {
    const result = expectDefined(results[index], "sandbox session read result");
    if (!result.ok) {
      throw result.error;
    }
    const byKey = new Map(result.value.map(({ sessionKey, entry }) => [sessionKey, entry]));
    const readSession: typeof resolveSessionEntry = ({ sessionKey }) => ({
      existing: byKey.get(sessionKey),
      normalizedKey: sessionKey,
      legacyKeys: [],
    });
    // Retained or removed entries still need the configured mode classification.
    return params.sessionKeys.map((sessionKey) =>
      resolveSandboxRuntimeStatusWithRead({ ...params, sessionKey }, readSession),
    );
  });
}

function resolveSandboxClassification(params: SandboxRuntimeStatusParams) {
  const sessionKey = params.sessionKey?.trim() ?? "";
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: params.cfg,
    agentId: params.agentId,
  });
  const classificationSessionKey = params.classificationSessionKey?.trim() || sessionKey;
  const classificationAgentId = resolveSessionAgentId({
    sessionKey: classificationSessionKey,
    config: params.cfg,
    agentId: params.classificationAgentId,
    // Reuse the owner only for this session; independent targets still need their own identity.
    fallbackAgentId: classificationSessionKey === sessionKey ? agentId : undefined,
  });
  const cfg = params.cfg;
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, classificationAgentId);
  const mainSessionKey = resolveMainSessionKeyForSandbox({ cfg, agentId: classificationAgentId });
  const comparableSessionKey = canonicalizeMainSessionAlias({
    cfg,
    agentId: classificationAgentId,
    sessionKey: classificationSessionKey,
  });
  return {
    sessionKey,
    agentId,
    classificationSessionKey,
    classificationAgentId,
    cfg,
    sandboxCfg,
    mainSessionKey,
    comparableSessionKey,
  };
}

function resolveSandboxRuntimeStatusWithRead(
  params: SandboxRuntimeStatusParams,
  readSession: typeof resolveSessionEntry,
  classification = resolveSandboxClassification(params),
): {
  agentId: string;
  sessionKey: string;
  classificationAgentId: string;
  classificationSessionKey: string;
  mainSessionKey: string;
  mode: SandboxConfig["mode"];
  sandboxed: boolean;
  toolPolicy: SandboxToolPolicyResolved;
} & SandboxRuntimeIsolation {
  const {
    sessionKey,
    agentId,
    classificationSessionKey,
    classificationAgentId,
    cfg,
    sandboxCfg,
    mainSessionKey,
    comparableSessionKey,
  } = classification;
  // Creation owns this immutable requirement; current callers and agent mode cannot relax it.
  const session =
    params.preparedSessionEntry !== undefined
      ? { existing: params.preparedSessionEntry ?? undefined, normalizedKey: comparableSessionKey }
      : classificationSessionKey
        ? readSession(
            {
              agentId: classificationAgentId,
              clone: false,
              sessionKey: comparableSessionKey,
              storePath: resolveSessionStorePathCore(cfg?.session?.store, {
                agentId: classificationAgentId,
              }),
            },
            { readOnly: true },
          )
        : undefined;
  const sandboxRequired = session?.existing?.sandbox === "required";
  const profileId = sessionCreatorProfileId(session?.existing?.createdActor)?.trim();
  const isolation: SandboxRuntimeIsolation = sandboxRequired
    ? {
        sandboxRequired: true,
        createdActor: session.existing?.createdActor,
        isolationSubject: profileId
          ? { kind: "profile", profileId }
          : { kind: "session", sessionKey: session.normalizedKey },
        workspaceAccess: sandboxCfg.workspaceAccess === "rw" ? "ro" : sandboxCfg.workspaceAccess,
      }
    : { sandboxRequired: false };
  const sandboxed = classificationSessionKey
    ? shouldSandboxSession(
        sandboxCfg,
        comparableSessionKey,
        mainSessionKey,
        sandboxRequired,
        session?.existing?.sandboxMode,
      )
    : false;
  return {
    agentId,
    sessionKey,
    classificationAgentId,
    classificationSessionKey,
    mainSessionKey,
    mode: sandboxCfg.mode,
    ...isolation,
    sandboxed,
    toolPolicy: resolveSandboxToolPolicyForAgent(cfg, classificationAgentId),
  };
}

function hasUnsafeControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function redactSessionKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(unknown)";
  }
  if (trimmed.length <= 12) {
    return "(redacted)";
  }
  return `${escapeControlCharsVisible(truncateUtf16Safe(trimmed, 6))}…${escapeControlCharsVisible(sliceUtf16Safe(trimmed, -6))}`;
}

function shellEscapeSingleArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Formats the user-facing denial message when sandbox tool policy blocks a tool. */
export function formatSandboxToolPolicyBlockedMessage(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  toolName: string;
  audit?: boolean;
}): string | undefined {
  const tool = normalizeOptionalLowercaseString(params.toolName);
  if (!tool) {
    return undefined;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }

  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(
    tool,
    runtime.toolPolicy,
  );
  if (!blockedByDeny && !blockedByAllow) {
    return undefined;
  }

  const blockingSource = blockedByDeny
    ? runtime.toolPolicy.sources.deny
    : runtime.toolPolicy.sources.allow;
  if (params.audit === true) {
    // Audit only on actual enforcement paths; explain/status calls can format without side effects.
    auditSandboxToolPolicyBlock({
      toolName: tool,
      ruleType: blockedByDeny ? "deny" : "allow",
      ruleSource: blockingSource.source,
      configKey: blockingSource.key,
      policy: runtime.toolPolicy,
      mode: runtime.mode,
    });
  }

  const reasons: string[] = [];
  const fixes: string[] = [];
  if (blockedByDeny) {
    reasons.push("deny list");
    fixes.push(`Remove "${tool}" from ${runtime.toolPolicy.sources.deny.key}.`);
  }
  if (blockedByAllow) {
    reasons.push("allow list");
    fixes.push(
      `Add "${tool}" to ${runtime.toolPolicy.sources.allow.key} (or set it to [] to allow all).`,
    );
  }

  const lines: string[] = [];
  lines.push(`Tool "${tool}" blocked by sandbox tool policy (mode=${runtime.mode}).`);
  lines.push(`Session: ${redactSessionKey(runtime.sessionKey)}`);
  lines.push(`Reason: ${reasons.join(" + ")}`);
  lines.push("Fix:");
  lines.push(
    runtime.sandboxRequired
      ? "- This session requires a sandbox; create a new session under an authorized role."
      : "- agents.defaults.sandbox.mode=off (disable sandbox)",
  );
  for (const fix of fixes) {
    lines.push(`- ${fix}`);
  }
  if (runtime.mode === "non-main" && !runtime.sandboxRequired) {
    lines.push("- Use the agent main session instead of a non-main session.");
  }
  const explainCommand =
    runtime.sessionKey && !hasUnsafeControlChars(runtime.sessionKey)
      ? `openclaw sandbox explain --session ${shellEscapeSingleArg(runtime.sessionKey)} --agent ${runtime.agentId}`
      : `openclaw sandbox explain --agent ${runtime.agentId}`;
  lines.push(`- See: ${formatCliCommand(explainCommand)}`);

  return lines.join("\n");
}
