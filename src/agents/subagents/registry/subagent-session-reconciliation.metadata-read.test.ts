import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { observeMainThreadReads } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  resolveStoredSubagentCapabilities,
  resolvePersistedSubagentToolPolicyEnvelope,
} from "../spawn/subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import {
  loadSubagentSessionEntry,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

it("reads subagent lifecycle and policy metadata without decoding unrelated session payloads", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-point-read-"));
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    try {
      const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
      const childSessionKey = "agent:main:subagent:target";
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
      replaceSessionEntrySync(
        { storePath, sessionKey: childSessionKey },
        {
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
        },
      );
      const parse = vi.spyOn(JSON, "parse");
      const reads = observeMainThreadReads();
      const messages = vi.spyOn(Worker.prototype, "emit");
      let completion;
      try {
        completion = await resolveSubagentSessionCompletion({
          childSessionKey,
          cfg: { session: { store: storePath } },
          fallbackEndedAt: 3000,
        });
        const options = { cfg: { session: { store: storePath } } };
        expect(await resolveSubagentSessionStartedAt({ childSessionKey, ...options })).toBe(1000);
        const transferred = messages.mock.calls
          .filter(([event]) => event === "message")
          .map(([, message]) => JSON.stringify(message));
        expect(transferred.some((message) => message.includes('"sessionId":"target"'))).toBe(true);
        expect
          .soft(transferred.some((message) => message.includes("TARGET_COLD_PAYLOAD_")))
          .toBe(false);
        reads.clear();
        expect(loadSubagentSessionEntry({ childSessionKey, ...options })).toMatchObject({
          sessionId: "target",
          lifecycleRevision: "target-revision",
          status: "done",
          startedAt: 1000,
          endedAt: 2000,
        });
        const queries = reads.calls
          .flatMap((call) => call.mock.contexts)
          .map((statement) => (statement as StatementSync).sourceSQL)
          .filter((sql) => /from "session_nodes"/i.test(sql));
        expect(queries).toHaveLength(1);
        expect.soft(queries.some((sql) => sql.includes("session_entry_snapshots"))).toBe(false);
        expect
          .soft(parse.mock.calls.some(([value]) => value.includes("TARGET_COLD_PAYLOAD_")))
          .toBe(false);
        expect(getSubagentDepthFromSessionStore(childSessionKey, options)).toBe(2);
        expect(getSubagentDepthFromSessionStore("target", options)).toBe(2);
        expect(resolveStoredSubagentCapabilities(childSessionKey, options)).toMatchObject({
          depth: 2,
          canSpawn: true,
        });
        expect(resolvePersistedSubagentToolPolicyEnvelope(childSessionKey, options)).toMatchObject({
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
      expect(completion).toMatchObject({
        startedAt: 1000,
        endedAt: 2000,
        outcome: { status: "ok" },
      });
      const params = {
        childSessionKey,
        cfg: { session: { store: storePath } },
        fallbackEndedAt: 3000,
      };
      replaceSessionEntrySync(
        { storePath, sessionKey: childSessionKey },
        {
          sessionId: "successor",
          updatedAt: 4000,
        },
      );
      expect(await resolveSubagentSessionCompletion(params)).toBeNull();
      expect(
        await resolveSubagentSessionCompletion({
          ...params,
          childSessionKey: "agent:main:subagent:missing",
        }),
      ).toBeNull();

      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteScope({ storePath, sessionKey: childSessionKey })),
      );
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?")
        .run('{"bad":true}', childSessionKey);
      await expect(resolveSubagentSessionCompletion(params)).rejects.toThrow(
        "invalid persisted session row requires repair",
      );

      expect(getSubagentDepthFromSessionStore(childSessionKey, { cfg: params.cfg })).toBe(1);
      expect(
        resolvePersistedSubagentToolPolicyEnvelope(childSessionKey, { cfg: params.cfg }),
      ).toBeUndefined();

      for (const [requested, stored, matches] of [
        ["Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room", true],
        ["agent:main:matrix:group:!Room:server", "agent:main:matrix:group:!room:server", false],
        ["agent:main:signal:group:AbCdEf==", "agent:main:signal:group:abcdef==", false],
      ] as const) {
        replaceSessionEntrySync(
          { storePath, sessionKey: stored },
          {
            sessionId: stored,
            updatedAt: 2000,
            endedAt: 2000,
            status: "done",
          },
        );
        const resolved = await resolveSubagentSessionCompletion({
          ...params,
          childSessionKey: requested,
        });
        expect(resolved?.outcome.status === "ok").toBe(matches);
      }
    } finally {
      await cleanupSessionStateForTest({ stateDir });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
