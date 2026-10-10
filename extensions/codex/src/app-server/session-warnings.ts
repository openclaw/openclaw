import { createHash } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { patchSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readCodexAppServerWarningMessage } from "./client-notifications.js";
import { readCodexNotificationScope } from "./notification-correlation.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";

const MAX_WARNING_RECEIPTS = 256;
// Operational/security warnings can recur meaningfully. Only the reported
// startup compatibility diagnostic is subject to once-per-chat delivery.
const ULTRAFAST_REQUIREMENT_WARNING_PREFIX =
  "Ignoring unknown `features` requirement `ultrafast_mode` from ";

type WarningSession = {
  agentId: string;
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
  expectedLifecycleRevision?: string;
};

function readWarningReceipts(entry: SessionEntry): string[] {
  const state = entry.pluginExtensions?.codex?.warningReceipts;
  if (
    !isJsonObject(state) ||
    state.version !== 1 ||
    state.sessionId !== entry.sessionId ||
    state.lifecycleRevision !== (entry.lifecycleRevision ?? null) ||
    !Array.isArray(state.hashes)
  ) {
    return [];
  }
  return state.hashes
    .slice(0, MAX_WARNING_RECEIPTS)
    .filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

/** Session-owned receipts survive native reconnects and Gateway restart, but not chat reset. */
export async function projectCodexSessionWarning(params: {
  session: WarningSession;
  threadId: string;
  notification: CodexServerNotification;
  assertCurrent: () => void;
  project: () => Promise<boolean>;
}): Promise<void> {
  const { notification, session } = params;
  const body = isJsonObject(notification.params) ? notification.params : undefined;
  const scope = readCodexNotificationScope(body);
  const message = body ? readCodexAppServerWarningMessage(body) : "";
  if (
    (notification.method !== "warning" && notification.method !== "configWarning") ||
    !body ||
    !message.startsWith(ULTRAFAST_REQUIREMENT_WARNING_PREFIX) ||
    message.length === ULTRAFAST_REQUIREMENT_WARNING_PREFIX.length ||
    !session.sessionKey ||
    (scope.threadId && scope.threadId !== params.threadId)
  ) {
    params.assertCurrent();
    await params.project();
    return;
  }
  // Native thread/client ids are transport identities, not warning content.
  // Include diagnostic location so different policy errors remain distinguishable.
  const hash = createHash("sha256")
    .update(JSON.stringify([message, body.path ?? null, body.range ?? null]))
    .digest("hex");
  let foundSession = false;
  let projectionAttempted = false;
  const project = async () => {
    params.assertCurrent();
    projectionAttempted = true;
    return await params.project();
  };
  try {
    await patchSessionEntry({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      storePath: session.storePath,
      preserveActivity: true,
      requireWriteSuccess: true,
      skipMaintenance: true,
      // The canonical session write FIFO serializes the read/project/acknowledge
      // sequence across attempts. No SQLite transaction is held while projecting.
      update: async (entry) => {
        foundSession = true;
        params.assertCurrent();
        if (
          entry.sessionId !== session.sessionId ||
          (session.expectedLifecycleRevision !== undefined &&
            entry.lifecycleRevision !== session.expectedLifecycleRevision)
        ) {
          return null;
        }
        const hashes = readWarningReceipts(entry);
        if (hashes.includes(hash)) {
          return null;
        }
        if (!(await project())) {
          return null;
        }
        params.assertCurrent();
        // Never evict an acknowledged warning from this chat. At capacity, new
        // distinct warnings remain visible rather than suppressing unseen policy.
        if (hashes.length >= MAX_WARNING_RECEIPTS) {
          return null;
        }
        return {
          pluginExtensions: {
            ...entry.pluginExtensions,
            codex: {
              ...entry.pluginExtensions?.codex,
              warningReceipts: {
                version: 1,
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision ?? null,
                hashes: [...hashes, hash],
              },
            },
          },
        };
      },
    });
  } catch (error) {
    // A storage refusal must not hide the warning. A failed or already completed
    // projection, however, must never be repeated inside this same attempt.
    if (projectionAttempted) {
      throw error;
    }
    params.assertCurrent();
    embeddedAgentLog.debug("Codex warning receipt store unavailable", { error });
    await project();
    return;
  }
  // Ephemeral invocations without a stored OpenClaw chat cannot retain receipts.
  if (!foundSession) {
    await project();
  }
}
