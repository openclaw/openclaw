import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import {
  contextEngineCompactMock,
  createAgentSessionMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let compact: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let workspaceDir: string;
const sessionId = "terminal-metadata";
const sessionKey = "agent:main:terminal-metadata";

beforeAll(async () => {
  ({ compactEmbeddedAgentSessionDirect: compact } = await loadCompactHooksHarness());
});

beforeEach(async () => {
  workspaceDir = tempDirs.make("openclaw-terminal-compaction-");
  resetCompactHooksHarnessMocks(workspaceDir);
  resolveContextEngineMock.mockResolvedValue({
    info: { ownsCompaction: false },
    compact: contextEngineCompactMock,
  });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath: join(workspaceDir, "sessions.json") },
    { sessionId, updatedAt: 1 },
  );
});

it.each(["bootstrap", "compaction"] as const)(
  "does not retry thinking after a recorded terminal %s failure",
  async (phase) => {
    const failure = Object.freeze(
      Object.assign(new Error("Reasoning is mandatory for this endpoint"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
    );
    recordModelFallbackStop(failure);
    if (phase === "bootstrap") {
      createAgentSessionMock.mockRejectedValueOnce(failure);
    } else {
      sessionCompactImpl.mockRejectedValueOnce(failure);
    }

    const result = await compact({
      agentId: "main",
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      sessionTarget: {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: join(workspaceDir, "sessions.json"),
      },
      workspaceDir,
      provider: "openai",
      model: "fixture-primary",
      modelFallbacksOverride: ["openai/fixture-fallback"],
      thinkLevel: "off",
      customInstructions: "preserve the committed state",
      enqueue: async (task) => await task(),
    });

    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(sessionCompactImpl).toHaveBeenCalledTimes(phase === "bootstrap" ? 0 : 1);
    expect(result).toMatchObject({ ok: false, compacted: false });
  },
);
