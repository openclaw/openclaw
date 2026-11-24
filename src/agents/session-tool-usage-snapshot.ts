import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSessionToolUsageRanking } from "./embedded-agent-runner/session-prompt-state.js";
import {
  readToolUsageRankingSnapshot,
  type ToolUsageRankingSnapshot,
} from "./tool-usage-ranking.js";

/** Authenticated inspection and inactive-parent spawn use the existing history reader. */
export async function readSessionToolUsageRankingSnapshot(params: {
  agentId: string;
  sessionKey: string;
  config: import("../config/types.openclaw.js").OpenClawConfig;
  assertCurrent: () => void;
}): Promise<ToolUsageRankingSnapshot | undefined> {
  const { resolveGatewaySessionStoreTargetInWorker } =
    await import("../gateway/session-utils-store-worker.js");
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.config,
    key: params.sessionKey,
    agentId: params.agentId,
    readOnly: true,
    projection: "list",
    assertActive: params.assertCurrent,
  });
  const entry = target.store[target.canonicalKey];
  if (!entry) {
    return undefined;
  }
  const resident = getSessionToolUsageRanking(entry.sessionId);
  if (resident) {
    return resident;
  }
  const { findTranscriptEvent } = await import("../config/sessions/session-transcript-match.js");
  const found = await findTranscriptEvent(
    {
      agentId: params.agentId,
      sessionKey: target.canonicalKey,
      sessionId: entry.sessionId,
      storePath: target.readSource?.path ?? target.storePath,
    },
    { kind: "custom-entry", customType: "openclaw.system-prompt" },
  );
  params.assertCurrent();
  const event = found?.event;
  return isRecord(event) && isRecord(event.data)
    ? readToolUsageRankingSnapshot(event.data.usageRanking)
    : readToolUsageRankingSnapshot(entry.toolUsageRankingSeed);
}
