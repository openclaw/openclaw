// Subagent list metadata-read regression: the common list builder consumes only
// session metadata (model, token usage, status), so it must read through the list
// projection and never decode unrelated saved prompt payloads.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildSubagentList } from "./subagent-list.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

it("builds the subagent list without decoding unrelated saved prompts", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-list-metadata-"));
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    try {
      resetSubagentRegistryForTests();
      const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
      const childSessionKey = "agent:main:subagent:target";
      for (let i = 0; i < 20; i++) {
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
          updatedAt: Date.now(),
          inputTokens: 12,
          outputTokens: 1000,
          totalTokens: 197000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          model: "opencode/claude-opus-4-6",
        },
      );
      const run = {
        runId: "run-metadata-target",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "inspect metadata reads",
        cleanup: "keep",
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      } satisfies SubagentRunRecord;
      addSubagentRunForTests(run);

      const parse = vi.spyOn(JSON, "parse");
      let list;
      try {
        list = buildSubagentList({
          cfg: { session: { store: storePath } } as OpenClawConfig,
          runs: [run],
          recentMinutes: 30,
          taskMaxChars: 110,
        });
        const unrelatedParses = parse.mock.calls.filter(
          ([value]) => typeof value === "string" && value.includes("UNRELATED_PAYLOAD_"),
        ).length;
        expect(unrelatedParses).toBe(0);
      } finally {
        parse.mockRestore();
      }
      expect(list.active).toHaveLength(1);
      expect(list.active[0]).toMatchObject({
        runId: run.runId,
        sessionKey: childSessionKey,
      });
      expect(list.active[0]?.totalTokens).toBe(197000);
      expect(list.active[0]?.line).toMatch(/prompt\/cache 197k/);
    } finally {
      resetSubagentRegistryForTests();
      await cleanupSessionStateForTest({ stateDir });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
