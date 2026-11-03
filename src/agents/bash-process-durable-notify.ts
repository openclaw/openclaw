import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { isSubagentEnvelopeSession } from "./subagents/spawn/subagent-capabilities.js";
import { withoutGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

/** Restart completions are fresh host input, never restored requester continuations. */
export async function prepareAdoptedDurableProcessNotification(
  session: ProcessSession,
  persistedSessionId: string,
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
    if (target.sessionId !== persistedSessionId) {
      session.notifyOnExit = false;
      return;
    }
    const entry = await readSessionEntryReadOnlyInWorker(
      { agentId, sessionKey, storePath: target.storePath },
      assertNotificationsEnabled,
    );
    if (
      entry?.sessionId !== persistedSessionId ||
      entry.archivedAt !== undefined ||
      entry.incognito ||
      isSubagentEnvelopeSession(sessionKey, { entry })
    ) {
      session.notifyOnExit = false;
      return;
    }
    // Session-event admission pins this generation and prepares the principal's
    // current authority at execution; config changes also remain live at effects.
    session.notifySessionTarget = target;
  } catch {
    session.notifyOnExit = false;
  }
}
