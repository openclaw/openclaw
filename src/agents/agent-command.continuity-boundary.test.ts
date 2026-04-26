import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

const emittedDiagnostics = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const pendingState = vi.hoisted(() => ({ value: false }));

vi.mock("../infra/continuity-diagnostics.js", () => ({
  emitContinuityDiagnostic: vi.fn((params: Record<string, unknown>) => {
    emittedDiagnostics.push(params);
    return params;
  }),
}));

vi.mock("../infra/outbound/pending-spawn-query.js", () => ({
  resolvePendingSpawnedChildren: vi.fn(() => pendingState.value),
}));

import { __testing } from "./agent-command.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  emittedDiagnostics.length = 0;
  pendingState.value = false;
});

describe("agent-command continuity boundary freshen", () => {
  test("records next-turn freshen marker and emits stale-risk diagnostics once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boundary-freshen-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:main";
    const boundaryMetadata = {
      version: 1,
      type: "compact.boundary",
      boundaryId: "compact-boundary:test",
      createdAt: 123,
      state: {
        sessionBinding: {
          sessionKey,
          sessionId: "session-live",
          agentId: "main",
          channel: "discord",
          accountId: "account-1",
          threadId: "thread-1",
        },
        approval: {
          captured: false,
          reason: "approval live state is captured by the dedicated approval mismatch guard",
        },
        outbound: { channel: "discord", targetId: "user-1", threadId: "thread-1" },
        children: { pendingDescendantState: "live-query-required", livePendingDescendants: false },
        policy: { provider: "openai", model: "gpt-test", thinkingLevel: "high" },
      },
    } as const;
    const entry: SessionEntry = {
      sessionId: "session-live",
      updatedAt: Date.now(),
      channel: "discord",
      lastAccountId: "account-1",
      lastThreadId: "thread-1",
      providerOverride: "openai",
      modelOverride: "gpt-test",
      thinkingLevel: "high",
      continuityRestore: {
        usedBoundary: {
          type: "continuity.restore.used_boundary",
          checkpointId: "checkpoint-1",
          boundaryId: boundaryMetadata.boundaryId,
          restoredAt: 456,
          boundaryMetadata,
        },
      },
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf8");

    const next = await __testing.freshenRestoredBoundaryForNextTurn({
      sessionEntry: entry,
      sessionStore,
      storePath,
      sessionKey,
      sessionId: "session-live",
      sessionAgentId: "main",
      runId: "run-1",
      configuredProvider: "openai",
      configuredModel: "gpt-test",
      persistedThinking: "high",
    });

    expect(next?.continuityRestore?.nextTurnFreshened).toMatchObject({
      boundaryId: boundaryMetadata.boundaryId,
      checkpointId: "checkpoint-1",
      mismatchCount: 0,
      fallbackKeys: [],
      livePendingDescendants: false,
      pendingDescendantCount: 0,
      staleRiskCount: 3,
    });
    expect(emittedDiagnostics.map((event) => event.type)).toEqual([
      "continuity.restore.boundary_freshened",
      "continuity.restore.boundary_stale_risk",
    ]);
    expect(emittedDiagnostics[0]).toMatchObject({
      severity: "info",
      phase: "next_turn_freshen",
      sessionKey,
      correlation: { boundaryId: boundaryMetadata.boundaryId, checkpointId: "checkpoint-1" },
    });
    expect(emittedDiagnostics[1]).toMatchObject({
      severity: "info",
      details: {
        risks: [
          { slot: "approval", status: "not-captured" },
          { slot: "acp", status: "missing-seed" },
          { slot: "wake", status: "missing-seed" },
        ],
      },
    });

    emittedDiagnostics.length = 0;
    const second = await __testing.freshenRestoredBoundaryForNextTurn({
      sessionEntry: next,
      sessionStore,
      storePath,
      sessionKey,
      sessionId: "session-live",
      sessionAgentId: "main",
    });

    expect(second).toBe(next);
    expect(emittedDiagnostics).toEqual([]);
  });

  test("detects boundary/live mismatches", () => {
    const result = __testing.collectContinuityMismatches(
      { channel: "discord", accountId: "account-1", threadId: "thread-1" },
      { channel: "slack", accountId: "account-1" },
      "sessionBinding",
    );

    expect(result).toEqual({
      mismatches: [{ key: "sessionBinding.channel", boundary: "discord", live: "slack" }],
      fallbackKeys: ["sessionBinding.threadId"],
    });
  });
});
