import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readScheduledMemoryParent } from "../../../cron/execution-context-registry.js";
import {
  assertMemoryAudienceSession,
  isHostMemoryAudience,
  resolveMemoryAudienceFromEntry,
} from "../../../plugins/memory-audience.js";
import type { MemoryAudience } from "../../../plugins/memory-provider-types.js";
import { resolveLoadedMemoryProviderKind } from "../../../plugins/memory-state.js";
import type { AdmittedRunContext } from "../../admitted-run-context.js";
import { log } from "../logger.js";

const retainedAudience = () => {};

/** The run's own memory inputs, as the embedded and CLI runners receive them. */
type AttemptMemoryRun = {
  memoryAudience?: MemoryAudience;
  config?: OpenClawConfig;
  senderIsOwner?: boolean;
  admittedRunContext?: AdmittedRunContext;
};

/**
 * Keep a delegated audience bound to this attempt, or resolve its admitted
 * source row. A scheduled child run resolves from its execution context's
 * parent instead of its own run row. The returned release ends the
 * attempt-owned session leases.
 */
export async function resolveEmbeddedAttemptMemoryAudience(params: {
  run: AttemptMemoryRun;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  admission?: { entry: SessionEntry; storePath: string };
  assertCallerCurrent?: () => void;
}): Promise<{ memoryAudience?: MemoryAudience; release: () => void }> {
  const { run } = params;
  if (run.memoryAudience) {
    if (!isHostMemoryAudience(run.memoryAudience)) {
      throw new Error("Embedded run memory audience must be host-minted.");
    }
    // The delegating owner keeps custody of a supplied audience's leases.
    assertMemoryAudienceSession(run.memoryAudience, params.sessionKey);
    return { memoryAudience: run.memoryAudience, release: retainedAudience };
  }
  // Detached maintenance runs use their explicit delegation instead of deriving
  // access from the maintenance copy's deliberately non-owner sender bit. Only a
  // native memory provider consumes audiences; legacy owners resolve none, so
  // their turns take no session leases and read no lineage.
  if (!params.admission || resolveLoadedMemoryProviderKind(run.config ?? {}) !== "native") {
    return { release: retainedAudience };
  }
  const resolution = await resolveMemoryAudienceFromEntry(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      senderIsOwner: run.senderIsOwner,
      storePath: params.admission.storePath,
      resolveAgentStorePath: (hopAgentId) =>
        resolveSessionStorePathForScope({ agentId: hopAgentId }, run.config),
      scheduledParent: readScheduledMemoryParent(run.admittedRunContext?.operationalRunInstance),
      assertCallerCurrent: params.assertCallerCurrent,
    },
    params.admission.entry,
  );
  if (resolution.status === "granted") {
    return { memoryAudience: resolution.audience, release: resolution.release };
  }
  // A denial grants no private or conversation memory, and memory tools then
  // fail pointing at this entry. Stale lineage warns because its reason names
  // the only repair; every other denial stays visible at info.
  const message = `memory audience unavailable: ${resolution.reason}`;
  const meta = {
    event: "memory_audience_denied",
    kind: resolution.kind,
    sessionKey: params.sessionKey,
  };
  log[resolution.kind === "stale-lineage" ? "warn" : "info"](message, meta);
  return { release: retainedAudience };
}
