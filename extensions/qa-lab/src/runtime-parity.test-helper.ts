import path from "node:path";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

export function createRuntimeParityTranscriptHarness() {
  const tempDirs = createTempDirHarness();

  async function seedRuntimeParityTranscript(params: {
    heartbeatIsolatedBaseSessionKey?: string;
    messages: Array<Record<string, unknown>>;
    sessionId: string;
    sessionKey: string;
    tempRoot?: string;
    trajectoryEvents?: Array<{
      data?: Record<string, unknown>;
      type: string;
    }>;
    updatedAt?: number;
  }) {
    const tempRoot = params.tempRoot ?? (await tempDirs.makeTempDir("openclaw-qa-runtime-parity-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
    const storePath = resolveStorePath(undefined, { agentId: "qa", env });
    await upsertSessionEntry({
      agentId: "qa",
      env,
      sessionKey: params.sessionKey,
      storePath,
      entry: {
        sessionId: params.sessionId,
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "qa",
          sessionId: params.sessionId,
          storePath,
        }),
        updatedAt: params.updatedAt ?? 100,
        ...(params.heartbeatIsolatedBaseSessionKey
          ? { heartbeatIsolatedBaseSessionKey: params.heartbeatIsolatedBaseSessionKey }
          : {}),
      },
    });
    for (const [index, message] of params.messages.entries()) {
      await appendSessionTranscriptMessageByIdentity({
        agentId: "qa",
        env,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath,
        now: index + 1,
        message,
      });
    }
    if (params.trajectoryEvents?.length) {
      appendSqliteTrajectoryRuntimeEvents(
        { agentId: "qa", env, sessionId: params.sessionId, storePath },
        params.trajectoryEvents.map((event, index) => ({
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: params.sessionId,
          source: "runtime",
          type: event.type,
          ts: new Date(index + 1).toISOString(),
          seq: index + 1,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: "run-1",
          data: event.data,
        })),
      );
    }
    return tempRoot;
  }

  return { seedRuntimeParityTranscript, cleanup: tempDirs.cleanup };
}
