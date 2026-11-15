import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach } from "vitest";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

export function createParitySessionFixture() {
  const tempDirs = createTempDirHarness({ beforeCleanup: closeQaRuntimeStores });
  afterEach(() => resetPluginStateStoreForTests({ closeDatabase: false }));
  afterAll(() => tempDirs.cleanup());

  return async function seedSession(params: {
    messages: Array<Record<string, unknown>>;
    sessionId: string;
    sessionKey: string;
    parentSessionKey?: string;
    tempRoot?: string;
    updatedAt?: number;
    sequenceMessageTimes?: boolean;
    trajectoryEvents?: Array<{ data?: Record<string, unknown>; type: string }>;
  }) {
    const { sessionId, sessionKey } = params;
    const tempRoot = params.tempRoot ?? (await tempDirs.makeTempDir("qa-runtime-parity-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
    const storePath = resolveStorePath(undefined, { agentId: "qa", env });
    const identity = { agentId: "qa", env, storePath, sessionId, sessionKey };
    await upsertSessionEntry({
      ...identity,
      entry: {
        sessionId,
        sessionFile: formatSqliteSessionFileMarker(identity),
        updatedAt: params.updatedAt ?? 100,
        ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
      },
    });
    for (const [index, message] of params.messages.entries()) {
      await appendSessionTranscriptMessageByIdentity({
        ...identity,
        message,
        ...(params.sequenceMessageTimes ? { now: index + 1 } : {}),
      });
    }
    if (params.trajectoryEvents?.length) {
      appendSqliteTrajectoryRuntimeEvents(
        identity,
        params.trajectoryEvents.map((event, index) => ({
          traceSchema: "openclaw-trajectory",
          schemaVersion: 1,
          traceId: sessionId,
          source: "runtime",
          type: event.type,
          ts: new Date(index + 1).toISOString(),
          seq: index + 1,
          sessionId,
          sessionKey,
          runId: "run-1",
          data: event.data,
        })),
      );
    }
    return tempRoot;
  };
}
