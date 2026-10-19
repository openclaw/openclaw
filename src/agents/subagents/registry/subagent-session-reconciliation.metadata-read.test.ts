import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { observeMainThreadReads } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  resolveStoredSubagentCapabilities as readCapabilities,
  resolvePersistedSubagentToolPolicyEnvelope as readPolicy,
} from "../spawn/subagent-capabilities.js";
import { getSubagentDepthFromSessionStoreInWorker as readDepth } from "../spawn/subagent-depth.js";
import { withPreparedSessionCapabilityRead } from "../spawn/subagent-session-store.js";
import {
  loadSubagentSessionEntry as readEntry,
  resolveSubagentSessionCompletion as readCompletion,
  resolveSubagentSessionStartedAt as readStartedAt,
} from "./subagent-session-reconciliation.js";

it("reads subagent lifecycle and policy metadata without decoding unrelated session payloads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents/main/sessions/sessions.json");
    const childSessionKey = "agent:main:subagent:target";
    const options = { cfg: { session: { store: storePath } } };
    const params = { childSessionKey, ...options, fallbackEndedAt: 3000 };
    const policy = () =>
      withPreparedSessionCapabilityRead(() => readPolicy(childSessionKey, options));
    const writeTarget = (entry: Parameters<typeof replaceSessionEntrySync>[1]) =>
      replaceSessionEntrySync({ storePath, sessionKey: childSessionKey }, entry);
    const coldPayload = `TARGET_COLD_PAYLOAD_${"x".repeat(65_536)}`;
    for (let i = 0; i < 100; i++) {
      replaceSessionEntrySync(
        { storePath, sessionKey: `agent:main:subagent:other-${i}` },
        {
          sessionId: `other-${i}`,
          updatedAt: 1,
          skillsSnapshot: { prompt: `UNRELATED_PAYLOAD_${"x".repeat(4096)}`, skills: [] },
        },
      );
    }
    writeTarget({
      sessionId: "target",
      updatedAt: 2000,
      startedAt: 1000,
      endedAt: 2000,
      status: "done",
      lifecycleRevision: "target-revision",
      sessionDiffBaseline: {
        version: 1,
        sessionId: "target",
        root: "/synthetic/workspace",
        files: [{ path: "fixture.ts", fingerprint: coldPayload }],
      },
      skillsSnapshot: { prompt: coldPayload, skills: [] },
      systemPromptReport: {
        source: "run",
        generatedAt: 1000,
        systemPrompt: { chars: 0, projectContextChars: 0, nonProjectContextChars: 0 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [{ name: coldPayload, blockChars: 0 }] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read"],
      inheritedToolDeny: ["exec"],
    });
    const parse = vi.spyOn(JSON, "parse");
    const reads = observeMainThreadReads();
    const messages = vi.spyOn(Worker.prototype, "emit");
    let completion;
    try {
      completion = await readCompletion(params);
      expect(await readStartedAt({ childSessionKey, ...options })).toBe(1000);
      const transferred = messages.mock.calls
        .filter(([event]) => event === "message")
        .map(([, message]) => JSON.stringify(message));
      expect(transferred.some((message) => message.includes('"sessionId":"target"'))).toBe(true);
      expect
        .soft(transferred.some((message) => message.includes("TARGET_COLD_PAYLOAD_")))
        .toBe(false);
      reads.clear();
      expect(await readEntry({ childSessionKey, ...options })).toMatchObject({
        sessionId: "target",
        lifecycleRevision: "target-revision",
        status: "done",
        startedAt: 1000,
        endedAt: 2000,
      });
      reads.expectIdle();
      expect
        .soft(parse.mock.calls.some(([value]) => value.includes("TARGET_COLD_PAYLOAD_")))
        .toBe(false);
      expect(await readDepth(childSessionKey, options)).toBe(2);
      expect(await readDepth("target", options)).toBe(2);
      expect(
        await withPreparedSessionCapabilityRead(() => readCapabilities(childSessionKey, options)),
      ).toMatchObject({ depth: 2, canSpawn: true });
      expect(await policy()).toMatchObject({
        spawnedBy: "agent:main:main",
        inheritedToolAllow: ["read"],
        inheritedToolDeny: ["exec"],
      });
      const unrelatedParses = parse.mock.calls.filter(
        ([value]) => typeof value === "string" && value.includes("UNRELATED_PAYLOAD_"),
      ).length;
      expect(unrelatedParses).toBe(0);
    } finally {
      messages.mockRestore();
      reads.restore();
      parse.mockRestore();
    }
    expect(completion).toMatchObject({ startedAt: 1000, endedAt: 2000, outcome: { status: "ok" } });
    writeTarget({ sessionId: "successor", updatedAt: 4000 });
    expect(await readCompletion(params)).toBeNull();
    expect(
      await readCompletion({ ...params, childSessionKey: "agent:main:subagent:missing" }),
    ).toBeNull();

    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteScope({ storePath, sessionKey: childSessionKey })),
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?")
      .run('{"bad":true}', childSessionKey);
    await expect(readCompletion(params)).rejects.toThrow(
      "invalid persisted session row requires repair",
    );

    await expect(readDepth(childSessionKey, options)).rejects.toThrow(
      "invalid persisted session row requires repair",
    );
    await expect(policy()).rejects.toThrow("invalid persisted session row requires repair");
  });
});
