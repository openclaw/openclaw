import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveSessionAgentIdsStrict } from "../agent-scope.js";
import { AgentHarnessPreflightError } from "./errors.js";
import { getRegisteredAgentHarness } from "./registry.js";
import type { AgentHarnessSessionRuntimeOwnership } from "./types.js";

type SessionRuntimeOwnershipReadParams = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: Partial<
    Pick<
      SessionEntry,
      | "sessionId"
      | "previousSessionId"
      | "agentHarnessId"
      | "modelSelectionLocked"
      | "pluginOwnerId"
    >
  >;
  assertCurrent?: () => void;
  /** Caller retains the fresh row through the ownership invocation. */
  readPreparedPreviousSessionId?: () => string | undefined;
};

function captureSessionRuntimeOwnershipRead(params: SessionRuntimeOwnershipReadParams) {
  const entry = params.sessionEntry;
  const sessionId = entry?.sessionId;
  const harnessId = resolveSessionPinnedHarnessId(entry);
  if (!sessionId || !harnessId) {
    return undefined;
  }
  const harness = getRegisteredAgentHarness(harnessId)?.harness;
  if (!harness) {
    return undefined;
  }
  const { agentId, sessionKey, storePath } = params;
  const privateSource = sessionKey
    ? captureIncognitoSessionSource({ agentId, sessionKey, storePath })
    : undefined;
  const claim =
    privateSource && !("kind" in privateSource)
      ? privateSource.actor.sessions.captureCurrent(sessionKey!)
      : undefined;
  let active = true;
  const assertCurrent = () => {
    if (active) {
      params.assertCurrent?.();
      privateSource?.admissionSignal?.throwIfAborted();
      if (privateSource && "kind" in privateSource) {
        privateSource.assertCurrent();
      }
      claim?.assertCurrent();
    }
    if (
      !active ||
      getRegisteredAgentHarness(harnessId)?.harness !== harness ||
      entry?.sessionId !== sessionId ||
      resolveSessionPinnedHarnessId(entry) !== harnessId
    ) {
      throw new AgentHarnessPreflightError(
        "Native session ownership changed while reading its runtime. Reattach the original native session before retrying.",
      );
    }
  };
  return {
    harness,
    sessionId,
    privateSource,
    assertCurrent,
    input: {
      config: params.config,
      agentId: params.agentId,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      assertCurrent,
    },
    finish(ownership: AgentHarnessSessionRuntimeOwnership | undefined) {
      assertCurrent();
      return ownership
        ? { ...ownership, ...(ownership.modelRef ? { modelRef: { ...ownership.modelRef } } : {}) }
        : undefined;
    },
    close() {
      active = false;
    },
  };
}

function previousSessionReadScope(params: SessionRuntimeOwnershipReadParams) {
  const { config, agentId, sessionKey, storePath } = params;
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIdsStrict({ config, agentId, sessionKey });
  return {
    agentId: sessionAgentId,
    sessionKey: key,
    storePath:
      storePath?.trim() ||
      resolveSessionStorePathCore(config?.session?.store, { agentId: sessionAgentId }),
    hydrateSkillPromptRefs: false,
    readConsistency: "latest" as const,
  };
}

/** Retained native adapter for final authority checks and the released synchronous hook. */
export function readSessionRuntimeOwnership(
  params: SessionRuntimeOwnershipReadParams,
): AgentHarnessSessionRuntimeOwnership | undefined {
  const read = captureSessionRuntimeOwnershipRead(params);
  if (!read) {
    return undefined;
  }
  const { harness, sessionId, privateSource, assertCurrent } = read;
  try {
    assertCurrent();
    if (harness.resolveSessionRuntimeOwnership) {
      warnPluginSdkDeprecation({
        family: "agent-harness-session-runtime-ownership",
        method: "AgentHarness.resolveSessionRuntimeOwnership",
        replacement: "AgentHarness.resolveSessionRuntimeOwnershipAsync",
        pluginId: getRegisteredAgentHarness(harness.id)?.ownerPluginId,
        compatibility:
          "The synchronous hook remains available for released plugins and final authority checks.",
      });
    }
    return read.finish(
      harness.resolveSessionRuntimeOwnership?.({
        ...read.input,
        readPreviousSessionId: () => {
          assertCurrent();
          if (params.readPreparedPreviousSessionId) {
            const previousSessionId = params.readPreparedPreviousSessionId();
            assertCurrent();
            return previousSessionId;
          }
          if (privateSource) {
            const key = params.sessionKey?.trim();
            const current =
              !key || "kind" in privateSource
                ? undefined
                : privateSource.actor.sessions.readSharing(key)?.entry;
            assertCurrent();
            return current?.sessionId === sessionId ? current.previousSessionId : undefined;
          }
          // The synchronous compatibility hook consumes the row its caller already prepared.
          return params.sessionEntry?.previousSessionId;
        },
        assertCurrent,
      }),
    );
  } finally {
    read.close();
  }
}

/** Prefer the worker-owned contract; the released synchronous hook is a selected legacy adapter. */
export async function readSessionRuntimeOwnershipAsync(
  params: SessionRuntimeOwnershipReadParams,
): Promise<AgentHarnessSessionRuntimeOwnership | undefined> {
  const read = captureSessionRuntimeOwnershipRead(params);
  if (!read) {
    return undefined;
  }
  const { harness, sessionId, privateSource, assertCurrent } = read;
  const resolveOwnership = harness.resolveSessionRuntimeOwnershipAsync?.bind(harness);
  if (!resolveOwnership) {
    read.close();
    return readSessionRuntimeOwnership(params);
  }
  try {
    assertCurrent();
    const ownership = await resolveOwnership({
      ...read.input,
      version: 2,
      readPreviousSessionId: async () => {
        assertCurrent();
        if (params.readPreparedPreviousSessionId) {
          const previousSessionId = params.readPreparedPreviousSessionId();
          assertCurrent();
          return previousSessionId;
        }
        if (privateSource) {
          const key = params.sessionKey?.trim();
          const current =
            !key || "kind" in privateSource
              ? undefined
              : privateSource.actor.sessions.readSharing(key)?.entry;
          assertCurrent();
          return current?.sessionId === sessionId ? current.previousSessionId : undefined;
        }
        const scope = previousSessionReadScope(params);
        const current = scope
          ? await readSessionEntryReadOnlyInWorker(scope, assertCurrent)
          : undefined;
        assertCurrent();
        return current?.sessionId === sessionId ? current.previousSessionId : undefined;
      },
      assertCurrent,
    });
    return read.finish(ownership);
  } finally {
    read.close();
  }
}
