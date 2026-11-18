import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  isSubagentEnvelopeSession,
  isVisibleSpawnedSession,
} from "./subagents/spawn/subagent-capabilities.js";
import { withoutGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

/** The wake facts of a restored process, prepared before or after it is registered. */
export type AdoptedProcessNotification = Pick<
  ProcessSession,
  "agentId" | "sessionKey" | "notifyOnExit" | "notifySessionTarget" | "cancellationRequested"
>;

/** Restart completions are fresh host input, never restored requester continuations. */
export async function prepareAdoptedDurableProcessNotification(
  session: AdoptedProcessNotification,
): Promise<void> {
  session.notifySessionTarget = undefined;
  const { agentId, sessionKey } = session;
  if (
    !session.notifyOnExit ||
    session.cancellationRequested ||
    !agentId ||
    !sessionKey ||
    isCronSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey)
  ) {
    session.notifyOnExit = false;
    return;
  }
  const assertNotificationsEnabled = () => {
    const cfg = getRuntimeConfigSnapshot();
    if (
      !cfg ||
      (resolveAgentConfig(cfg, agentId)?.tools?.exec?.notifyOnExit ??
        cfg.tools?.exec?.notifyOnExit) === false
    ) {
      throw new Error("Automatic exec completion notifications are disabled");
    }
  };
  try {
    assertNotificationsEnabled();
    const target = await withoutGatewayToolCallerIdentity(() =>
      captureSessionEventTargetForHost(agentId, sessionKey, {
        assertCurrent: assertNotificationsEnabled,
      }),
    );
    const entry = await readSessionEntryReadOnlyInWorker(
      { agentId, sessionKey, storePath: target.storePath },
      assertNotificationsEnabled,
    );
    if (
      !entry ||
      entry.archivedAt !== undefined ||
      entry.incognito ||
      (isSubagentEnvelopeSession(sessionKey, { entry }) &&
        !isVisibleSpawnedSession(sessionKey, { entry }))
    ) {
      session.notifyOnExit = false;
      return;
    }
    // The chat key follows transcript successors; admission prepares current authority.
    session.notifySessionTarget = target;
  } catch {
    session.notifyOnExit = false;
  }
}
