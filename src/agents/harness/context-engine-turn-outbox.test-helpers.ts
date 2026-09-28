import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { enqueueContextEngineTurnCommit } from "./context-engine-turn-outbox.js";
type ContextEngineTurnOutboxPayload = Parameters<
  typeof enqueueContextEngineTurnCommit
>[0]["payload"];

export async function createPersistedContextEngineTurn(params: {
  advancementKey: string;
  databasePath: string;
  sequence: number;
  sessionId: string;
}): Promise<ContextEngineTurnOutboxPayload> {
  const target = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: "agent:main:" + params.sessionId,
    storePath: params.databasePath,
  };
  await upsertSessionEntryCore(target, { sessionId: params.sessionId, updatedAt: params.sequence });
  const user = {
    role: "user" as const,
    content: params.advancementKey,
    timestamp: params.sequence,
  };
  const admitted = await appendTranscriptMessage(target, {
    eventId: params.advancementKey + ":user",
    message: user,
  });
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: params.sequence + 1,
  } satisfies import("../../../packages/agent-core/src/types.js").AgentMessage;
  const terminal = await appendTranscriptMessage(target, {
    eventId: params.advancementKey + ":assistant",
    message: assistant,
    parentId: admitted?.messageId,
  });
  if (!admitted?.anchor || !terminal?.anchor) {
    throw new Error("expected persisted turn anchors");
  }
  return {
    boundary: {
      admission: { ...admitted.anchor, logicalTurnId: params.advancementKey, role: "user" },
      terminal: terminal.anchor,
    },
    isHeartbeat: false,
    messages: [user, assistant],
  };
}
