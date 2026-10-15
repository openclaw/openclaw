// Covers one contract of the shared working-directory advisory: a cwd that
// spawn policy imposed is not the explicit request the advisory reports on.
//
// These cases live here rather than in `subagent-list.test.ts` because the
// oxlint `max-lines` cap for test files is 1000 effective lines and that file
// is already close to it. The split also follows a real seam — everything here
// is about how a run's cwd was *decided*, while the cases there are about how
// decided directories are grouped, canonicalized, capped and rendered.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildSubagentListForTests } from "./subagent-list.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-cwd-policy-"));
});

afterAll(async () => {
  await cleanupSessionStateForTest({ stateDir: testWorkspaceDir });
  await fs.rm(testWorkspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

beforeEach(async () => {
  await resetSubagentRegistryForTests();
});

describe("shared cwd advisory: policy-inherited roots", () => {
  const makeRun = (suffix: string, now: number): SubagentRunRecord =>
    ({
      runId: `run-${suffix}`,
      childSessionKey: `agent:main:subagent:${suffix}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: `work inside ${suffix}`,
      cleanup: "keep",
      createdAt: now - 120_000,
      execution: { status: "running", startedAt: now - 120_000 },
    }) satisfies SubagentRunRecord;

  const seedSessionEntry = async (
    storePath: string,
    sessionKey: string,
    spawnedCwd: string,
    options?: { senderRestricted?: boolean },
  ) => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: `session-${sessionKey}`,
        updatedAt: Date.now(),
        spawnedCwd,
        // The entry shape both spawn owners persist for a restricted helper:
        // the native owner through `buildSubagentSpawnSessionPatch`, the ACP
        // owner through its restricted creation patch in `acp-spawn.ts`.
        ...(options?.senderRestricted
          ? { inheritedToolPolicySource: "sender" as const, sessionRoot: spawnedCwd }
          : {}),
      },
    );
  };

  it("stays silent for sender-restricted helpers handed the requester's root", async () => {
    // A restricted sender's helpers cannot be pointed anywhere else: both
    // spawn owners reject a cwd that is not the requester root and then
    // persist that root as `spawnedCwd`. Every such pair collides by
    // construction, so the advisory has nothing actionable to report.
    const now = Date.now();
    const requesterRoot = path.join(testWorkspaceDir, "restricted-root");
    const runA = makeRun("restricted-a", now);
    const runB = makeRun("restricted-b", now);
    await addSubagentRunForTests(runA);
    await addSubagentRunForTests(runB);
    const storePath = path.join(testWorkspaceDir, "sessions-restricted.json");
    for (const run of [runA, runB]) {
      await seedSessionEntry(storePath, run.childSessionKey, requesterRoot, {
        senderRestricted: true,
      });
    }
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const list = await buildSubagentListForTests({ cfg, runs: [runA, runB], recentMinutes: 30 });

    expect(list.active).toHaveLength(2);
    expect(list.sharedCwdGroupTotal).toBe(0);
    expect(list.sharedCwdGroups).toEqual([]);
    for (const item of list.active) {
      expect(item.sharedCwdGroupId).toBeUndefined();
      expect(item.line).not.toContain("shared cwd");
    }
    expect(list.text).not.toContain("shared working director");
  });

  it("still reports the same directory when the pair is not sender-restricted", async () => {
    // Control for the case above: identical paths, identical runs, only the
    // policy marker removed. Pins that the exemption keys on how the cwd was
    // decided, not on the directory it happens to name.
    const now = Date.now();
    const requesterRoot = path.join(testWorkspaceDir, "restricted-root");
    const runA = makeRun("unrestricted-a", now);
    const runB = makeRun("unrestricted-b", now);
    await addSubagentRunForTests(runA);
    await addSubagentRunForTests(runB);
    const storePath = path.join(testWorkspaceDir, "sessions-unrestricted.json");
    for (const run of [runA, runB]) {
      await seedSessionEntry(storePath, run.childSessionKey, requesterRoot);
    }
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const list = await buildSubagentListForTests({ cfg, runs: [runA, runB], recentMinutes: 30 });

    expect(list.sharedCwdGroupTotal).toBe(1);
    expect(list.sharedCwdGroups).toEqual([
      {
        id: 1,
        path: path.resolve(requesterRoot),
        runCount: 2,
        runIds: [runA.runId, runB.runId],
      },
    ]);
  });

  it("keeps reporting the unrestricted peers when one run of the group is restricted", async () => {
    // The exemption is per run, not per directory: the restricted helper is
    // removed from the group while its two ordinary peers keep their advisory.
    const now = Date.now();
    const sharedDir = path.join(testWorkspaceDir, "restricted-mixed");
    const restricted = makeRun("mixed-restricted", now);
    const ordinary = makeRun("mixed-ordinary", now);
    const ordinaryPeer = makeRun("mixed-ordinary-peer", now);
    for (const run of [restricted, ordinary, ordinaryPeer]) {
      await addSubagentRunForTests(run);
    }
    const storePath = path.join(testWorkspaceDir, "sessions-mixed.json");
    await seedSessionEntry(storePath, restricted.childSessionKey, sharedDir, {
      senderRestricted: true,
    });
    await seedSessionEntry(storePath, ordinary.childSessionKey, sharedDir);
    await seedSessionEntry(storePath, ordinaryPeer.childSessionKey, sharedDir);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const list = await buildSubagentListForTests({
      cfg,
      runs: [restricted, ordinary, ordinaryPeer],
      recentMinutes: 30,
    });

    expect(list.sharedCwdGroupTotal).toBe(1);
    expect(list.sharedCwdGroups).toEqual([
      {
        id: 1,
        path: path.resolve(sharedDir),
        runCount: 2,
        runIds: [ordinary.runId, ordinaryPeer.runId],
      },
    ]);
    const byRunId = new Map(list.active.map((item) => [item.runId, item]));
    expect(byRunId.get(restricted.runId)?.sharedCwdGroupId).toBeUndefined();
    expect(byRunId.get(ordinary.runId)?.sharedCwdGroupId).toBe(1);
    expect(byRunId.get(ordinaryPeer.runId)?.sharedCwdGroupId).toBe(1);
  });
});
