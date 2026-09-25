import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { readUserTurnDelegatedInputPolicy } from "../../sessions/user-turn-transcript.metadata.js";
import { readRunDelegatedInputPolicies } from "../admitted-run-context.js";
import type { RunCliAgentParams, PreparedCliRunContext } from "./types.js";

function assertCliDelegatedActionPolicySupported(params: RunCliAgentParams): void {
  if (
    params.delegatedInputPolicy ||
    readRunDelegatedInputPolicies(params).length > 0 ||
    readUserTurnDelegatedInputPolicy(
      params.userTurnTranscriptRecorder?.getPendingInputMessage?.() ??
        params.userTurnTranscriptRecorder?.message,
    ) ||
    params.sessionEntry?.inheritedToolPolicy !== undefined ||
    (params.sessionEntry?.inheritedToolPolicyVersion !== undefined &&
      params.sessionEntry.inheritedToolPolicyVersion !== 1)
  ) {
    throw new Error(
      "This CLI runtime cannot enforce the delegated action policy. Use the embedded OpenClaw runtime.",
    );
  }
}

/** Verify inherited policy under the exact read scope before preparing CLI execution. */
export async function withCliDelegatedActionPolicy(
  inputParams: RunCliAgentParams,
  prepare: (params: RunCliAgentParams) => Promise<PreparedCliRunContext>,
): Promise<PreparedCliRunContext> {
  assertCliDelegatedActionPolicySupported(inputParams);
  const policySessionKey = inputParams.runtimePolicySessionKey ?? inputParams.sessionKey;
  const parsedPolicyKey = policySessionKey ? parseAgentSessionKey(policySessionKey) : undefined;
  if (
    (inputParams.sessionEntry === undefined ||
      (inputParams.runtimePolicySessionKey !== undefined &&
        inputParams.runtimePolicySessionKey !== inputParams.sessionKey)) &&
    policySessionKey &&
    parsedPolicyKey &&
    (isSubagentSessionKey(policySessionKey) || parsedPolicyKey.rest.startsWith("dashboard:"))
  ) {
    const cfg = inputParams.config ?? getRuntimeConfig();
    return withSessionEntryReadOnlyInWorker(
      {
        sessionKey: policySessionKey,
        agentId: parsedPolicyKey.agentId,
        storePath:
          (parsedPolicyKey.agentId === parseAgentSessionKey(inputParams.sessionKey ?? "")?.agentId
            ? inputParams.storePath
            : undefined) ??
          resolveSessionStorePathCore(cfg.session?.store, { agentId: parsedPolicyKey.agentId }),
        projection: "list",
        canonicalValidation: "selected",
      },
      () => {
        inputParams.assertCurrent?.();
        inputParams.abortSignal?.throwIfAborted();
      },
      async (read, assertCurrent) => {
        if (!read.ok || (!read.value && isSubagentSessionKey(policySessionKey))) {
          throw new Error("The CLI session's delegated action policy could not be verified.", {
            cause: read.ok ? undefined : read.error,
          });
        }
        assertCurrent();
        assertCliDelegatedActionPolicySupported({ ...inputParams, sessionEntry: read.value });
        return prepare(inputParams);
      },
    );
  }
  return prepare(inputParams);
}
