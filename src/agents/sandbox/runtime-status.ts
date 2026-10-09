import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
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
import { loadSessionEntryReadOnlyResultInScope } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  assertCapturedSessionEntryReadSource,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  resolveSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { assertSessionEntryCohortScope } from "../../config/sessions/session-entry-cohort-scope.js";
import { captureNativeSessionEntryCurrentRead } from "../../config/sessions/session-entry-current-runtime.js";
import {
  sessionCreatorProfileId,
  type SessionCreatedActor,
} from "../../config/sessions/session-entry-provenance.js";
import { SessionEntryChangedDuringReadError } from "../../config/sessions/session-entry-read-errors.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
} from "../../config/sessions/session-entry-read-request.js";
import {
  withSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoreInWorker,
  withSessionEntriesFromStoresInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import type {
  SessionEntryWorkerRead,
  PreparedSessionEntryWorkerRead,
  SessionEntryCohortReader,
} from "../../config/sessions/session-entry-read-runtime.types.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../../config/sessions/session-store-target-inventory.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "../../config/sessions/store-entry.js";
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

export function resolveSandboxRuntimeStatus(params: SandboxRuntimeStatusParams) {
  return resolveSandboxRuntimeStatusForClassification(params);
}

/** Keep the classification read's captured owner alive through one asynchronous policy preparation. */
export async function withSandboxRuntimeStatusInWorker<T>(
  params: Omit<SandboxRuntimeStatusParams, "preparedSessionEntry">,
  source: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    assertCurrent: () => void;
    readSource?: CapturedSessionEntryReadSource;
    assertEntryCurrent?: (entry: SessionEntry | undefined) => void;
    reader?: SessionEntryCohortReader;
  },
  consume: (runtime: ReturnType<typeof resolveSandboxRuntimeStatus>) => Promise<T>,
): Promise<T> {
  source.assertCurrent();
  const classification = resolveSandboxClassification(params);
  const prepare = (entry: SessionEntry | undefined) => {
    source.assertCurrent();
    source.assertEntryCurrent?.(entry);
    return consume(
      resolveSandboxRuntimeStatusForClassification(
        { ...params, preparedSessionEntry: entry ?? null },
        classification,
      ),
    );
  };
  if (!classification.classificationSessionKey) {
    const result = await prepare(undefined);
    source.assertCurrent();
    return result;
  }
  const assertCurrent = () => {
    source.assertCurrent();
    if (source.readSource && typeof source.readSource.databaseIdentity === "string") {
      assertCapturedSessionEntryReadSource(source.readSource);
    }
  };
  assertCurrent();
  const sessionKey = resolveSqliteSessionKey(
    classification.comparableSessionKey,
    classification.classificationAgentId,
  );
  const reader =
    source.reader?.logicalAgentId === classification.classificationAgentId &&
    source.reader.sessionKey === sessionKey
      ? source.reader
      : undefined;
  const scope = {
    agentId: classification.classificationAgentId,
    sessionKey,
    storePath:
      source.readSource?.path ??
      (reader && !params.cfg?.session?.store?.trim()
        ? reader.database.path
        : resolveSessionStorePathWithContext(
            params.cfg?.session?.store,
            {
              agentId: classification.classificationAgentId,
              env: source.env,
            },
            { cwd: source.cwd },
          )),
    env: source.env,
  };
  if (reader) {
    const key = assertSessionEntryCohortScope(reader, scope);
    const withClassification = <R>(
      consumeCurrent: (sandbox: ReturnType<typeof resolveSandboxRuntimeStatus>) => R,
    ) =>
      reader.withRead(
        { sessionKeys: [key], snapshotFields: [] },
        assertCurrent,
        (read, assertPrepared) => {
          assertPrepared();
          const entry = read.entries.find((row) => row.sessionKey === key)?.entry;
          source.assertEntryCurrent?.(entry);
          return consumeCurrent(
            resolveSandboxRuntimeStatusForClassification(
              { ...params, preparedSessionEntry: entry ?? null },
              classification,
            ),
          );
        },
      );
    const sandbox = await withClassification((current) => current);
    assertCurrent();
    reader.assertCurrent();
    const result = await consume(sandbox);
    // Preparation may await approvals or skills. Publish its result only under
    // a new phase's witness, with the same policy predicates it prepared against.
    return withClassification((current) => {
      if (!isDeepStrictEqual(current, sandbox)) {
        throw new SessionEntryChangedDuringReadError();
      }
      return result;
    });
  }
  if (isNativeSessionEntryRead(scope, scope.agentId)) {
    return withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return prepare(read.value);
    });
  }
  const candidates = captureSessionStoreReadCandidates(scope.storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  // Exact reads validate selected foreign row bytes without requiring a listing's writer proof.
  return withSessionEntriesFromStoreInWorker(
    {
      ...scope,
      sessionKeys: [
        normalizeStoreSessionKey(scope.sessionKey),
        ...collectSessionEntryLookupKeys(scope.sessionKey),
      ],
      projection: "exact",
    },
    async (read) => {
      assertCurrent();
      const result = await prepare(
        resolveSessionEntryCandidates({
          entries: read.result.entries,
          sessionKey: scope.sessionKey,
          canonicalKeys: true,
        }).existing?.entry,
      );
      assertCurrent();
      read.assertCurrent();
      return result;
    },
    false,
    (database, identity) => {
      const expected = identities.get(assertSessionStoreReadCandidate(database.path, candidates));
      if (!expected || expected.key !== identity.key || expected.birthtime !== identity.birthtime) {
        throw new Error("Sandbox classification source changed during preparation");
      }
    },
  );
}

/** Compare policies only after every original source has entered the same ordered read. */
export function withSandboxRuntimeStatusesInWorker<T>(
  requests: readonly Omit<SandboxRuntimeStatusParams, "preparedSessionEntry">[],
  source: { env: NodeJS.ProcessEnv; cwd: string; assertCurrent: () => void },
  consume: (statuses: readonly ReturnType<typeof resolveSandboxRuntimeStatus>[]) => T,
): Promise<T> {
  source.assertCurrent();
  const inputs: Array<SessionEntryWorkerRead & { sessionKeys: string[] }> = [];
  const projections = requests.map((params) => {
    const classification = resolveSandboxClassification(params);
    const project = (entry: SessionEntry | undefined) =>
      resolveSandboxRuntimeStatusForClassification(
        { ...params, preparedSessionEntry: entry ?? null },
        classification,
      );
    if (!classification.classificationSessionKey) {
      return () => project(undefined);
    }
    const storePath = resolveSessionStorePathWithContext(
      params.cfg?.session?.store,
      {
        agentId: classification.classificationAgentId,
        env: source.env,
      },
      { cwd: source.cwd },
    );
    const { scope } = captureSessionEntryReadScope({
      agentId: classification.classificationAgentId,
      sessionKey: resolveSqliteSessionKey(
        classification.comparableSessionKey,
        classification.classificationAgentId,
      ),
      storePath,
      env: source.env,
    });
    if (isNativeSessionEntryRead(scope, scope.agentId)) {
      const native = captureNativeSessionEntryCurrentRead(scope);
      return () => {
        native.assertSourceCurrent();
        const read = loadSessionEntryReadOnlyResultInScope(scope);
        if (!read.ok) {
          throw read.error;
        }
        native.assertSourceCurrent();
        return project(read.value);
      };
    }
    let input = inputs.find(
      (read) => read.agentId === scope.agentId && read.storePath === storePath,
    );
    if (!input) {
      input = {
        agentId: classification.classificationAgentId,
        storePath,
        env: scope.env,
        sessionKeys: [],
        projection: "exact",
      };
      inputs.push(input);
    }
    input.sessionKeys.push(
      normalizeStoreSessionKey(scope.sessionKey),
      ...collectSessionEntryLookupKeys(scope.sessionKey),
    );
    const index = inputs.indexOf(input);
    return (reads: readonly PreparedSessionEntryWorkerRead[]) =>
      project(
        resolveSessionEntryCandidates({
          entries: reads[index]!.result.entries,
          sessionKey: scope.sessionKey,
          canonicalKeys: true,
        }).existing?.entry,
      );
  });
  const captures = inputs.map((input) => {
    const candidates = captureSessionStoreReadCandidates(input.storePath);
    return { input, candidates, identities: captureSessionStoreCandidateIdentities(candidates) };
  });
  return withSessionEntriesFromStoresInWorker(
    inputs,
    (reads) => {
      source.assertCurrent();
      const statuses = projections.map((project) => project(reads));
      source.assertCurrent();
      const result = consume(statuses);
      source.assertCurrent();
      for (const read of reads) {
        read.assertCurrent();
      }
      return result;
    },
    {
      ordered: true,
      prepareSource(input, database, identity) {
        const captured = captures.find((capture) => capture.input === input)!;
        const expected = captured.identities.get(
          assertSessionStoreReadCandidate(database.path, captured.candidates),
        );
        if (
          !expected ||
          expected.key !== identity.key ||
          expected.birthtime !== identity.birthtime
        ) {
          throw new Error("Sandbox classification source changed during batch preparation");
        }
      },
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
    // Retained or removed entries still need the configured mode classification.
    return params.sessionKeys.map((sessionKey) => {
      const classification = resolveSandboxClassification({ ...params, sessionKey });
      return resolveSandboxRuntimeStatusForClassification(
        {
          ...params,
          sessionKey,
          preparedSessionEntry: byKey.get(classification.comparableSessionKey) ?? null,
        },
        classification,
      );
    });
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
  const mainSessionKey =
    cfg?.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg, agentId: classificationAgentId });
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

function resolveSandboxRuntimeStatusForClassification(
  params: SandboxRuntimeStatusParams,
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
        ? resolveSessionEntry(
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
  const sandboxed =
    Boolean(classificationSessionKey) &&
    (sandboxRequired ||
      (session?.existing?.sandboxMode !== "off" &&
        sandboxCfg.mode !== "off" &&
        (sandboxCfg.mode === "all" || comparableSessionKey.trim() !== mainSessionKey.trim())));
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
    runtime.sessionKey && !containsAsciiControlCharacter(runtime.sessionKey)
      ? `openclaw sandbox explain --session ${shellEscapeSingleArg(runtime.sessionKey)} --agent ${runtime.agentId}`
      : `openclaw sandbox explain --agent ${runtime.agentId}`;
  lines.push(`- See: ${formatCliCommand(explainCommand)}`);

  return lines.join("\n");
}
