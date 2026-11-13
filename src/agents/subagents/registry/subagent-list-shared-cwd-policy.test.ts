// Covers one contract of the shared working-directory advisory: a cwd that
// spawn policy imposed is not the explicit request the advisory reports on.
//
// These cases live here rather than in `subagent-list.test.ts` because that
// file already sits at the oxlint `max-lines` cap and `check:line-cap-ratchet`
// rejects any growth in it. The split is along a real seam — everything here
// is about how a run's cwd was *decided*, while the cases there are about how
// decided directories are grouped, canonicalized, capped and rendered.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { buildSubagentListForTests, expectedSharedCwdPath } from "./subagent-list.test-support.js";
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
  setRuntimeConfigSnapshot({});
  await resetSubagentRegistryForTests();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
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
    options?: { senderRestricted?: boolean; acpEffectiveCwd?: string },
  ) => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: `session-${sessionKey}`,
        updatedAt: Date.now(),
        spawnedCwd,
        // The entry shape both spawn owners persist for a restricted helper.
        // `subagent-spawn.workspace.test.ts` ("keeps a restricted same-agent
        // helper's tools and root") and `acp-spawn-policy.test-support.ts`
        // ("keeps a restricted same-agent ACP helper in the requester's root")
        // pin it against the real owners.
        ...(options?.senderRestricted
          ? { inheritedToolPolicySource: "sender" as const, sessionRoot: spawnedCwd }
          : {}),
        // The manager records the backend's effective cwd here
        // (`manager.initialize-session.ts`); `spawnedCwd` stays the request.
        ...(options?.acpEffectiveCwd
          ? {
              acp: {
                backend: "fixture-backend",
                agent: "fixture-harness",
                runtimeSessionName: `runtime-${sessionKey}`,
                mode: "oneshot" as const,
                state: "idle" as const,
                lastActivityAt: Date.now(),
                cwd: options.acpEffectiveCwd,
              },
            }
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
    const cfg: OpenClawConfig = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);

    const list = await buildSubagentListForTests({ cfg, runs: [runA, runB], recentMinutes: 30 });

    expect(list.active).toHaveLength(2);
    expect(list.sharedCwdGroupTotal).toBe(0);
    expect(list.sharedCwdGroups).toEqual([]);
    for (const item of list.active) {
      expect(item.sharedCwdGroupId).toBeUndefined();
      expect(item.line).not.toContain("shared cwd");
    }
    expect(list.text).not.toContain("shared working directories");
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
    const cfg: OpenClawConfig = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);

    const list = await buildSubagentListForTests({ cfg, runs: [runA, runB], recentMinutes: 30 });

    expect(list.sharedCwdGroupTotal).toBe(1);
    expect(list.sharedCwdGroups).toEqual([
      {
        id: 1,
        path: expectedSharedCwdPath(requesterRoot),
        runCount: 2,
        runIds: [runA.runId, runB.runId],
      },
    ]);
  });

  it("counts a restricted helper as a writer next to a run whose cwd was chosen", async () => {
    // Only a group made entirely of restricted helpers is unactionable. Next to
    // an ordinary run the helper is a second live writer, and that run can be
    // moved — dropping the helper first used to leave the pair unreported.
    const now = Date.now();
    const sharedDir = path.join(testWorkspaceDir, "restricted-mixed");
    const restricted = makeRun("mixed-restricted", now);
    const ordinary = makeRun("mixed-ordinary", now);
    for (const run of [restricted, ordinary]) {
      await addSubagentRunForTests(run);
    }
    const storePath = path.join(testWorkspaceDir, "sessions-mixed.json");
    await seedSessionEntry(storePath, restricted.childSessionKey, sharedDir, {
      senderRestricted: true,
    });
    await seedSessionEntry(storePath, ordinary.childSessionKey, sharedDir);
    const cfg: OpenClawConfig = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);

    const list = await buildSubagentListForTests({
      cfg,
      runs: [restricted, ordinary],
      recentMinutes: 30,
    });

    expect(list.sharedCwdGroups).toEqual([
      {
        id: 1,
        path: expectedSharedCwdPath(sharedDir),
        runCount: 2,
        runIds: [ordinary.runId, restricted.runId].toSorted(),
      },
    ]);
    const byRunId = new Map(list.active.map((item) => [item.runId, item]));
    expect(byRunId.get(restricted.runId)?.sharedCwdGroupId).toBe(1);
    expect(byRunId.get(ordinary.runId)?.sharedCwdGroupId).toBe(1);
  });

  it("groups an ACP run by the effective cwd its runtime reported", async () => {
    // Both ACP runs named `requested`, but the backend placed one elsewhere:
    // the named directory has a single live writer and the effective one two.
    const now = Date.now();
    const requested = path.join(testWorkspaceDir, "acp-requested");
    const effective = path.join(testWorkspaceDir, "acp-effective");
    const stayed = makeRun("acp-stayed", now);
    const moved = makeRun("acp-moved", now);
    const native = makeRun("acp-native-peer", now);
    for (const run of [stayed, moved, native]) {
      await addSubagentRunForTests(run);
    }
    const storePath = path.join(testWorkspaceDir, "sessions-acp-effective.json");
    await seedSessionEntry(storePath, stayed.childSessionKey, requested, {
      acpEffectiveCwd: requested,
    });
    await seedSessionEntry(storePath, moved.childSessionKey, requested, {
      acpEffectiveCwd: effective,
    });
    await seedSessionEntry(storePath, native.childSessionKey, effective);
    const cfg: OpenClawConfig = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);

    const list = await buildSubagentListForTests({
      cfg,
      runs: [stayed, moved, native],
      recentMinutes: 30,
    });

    expect(list.sharedCwdGroups).toEqual([
      {
        id: 1,
        path: expectedSharedCwdPath(effective),
        runCount: 2,
        runIds: [moved.runId, native.runId].toSorted(),
      },
    ]);
  });

  it("keeps directories that differ only by case apart on Windows", async () => {
    // A Windows directory can opt into case sensitivity, so `Tree` and `tree`
    // may be two checkouts. Their canonical identities already differ; folding
    // case by platform merged them into one group.
    const now = Date.now();
    const upper = makeRun("case-upper", now);
    const lower = makeRun("case-lower", now);
    for (const run of [upper, lower]) {
      await addSubagentRunForTests(run);
    }
    const storePath = path.join(testWorkspaceDir, "sessions-case.json");
    await seedSessionEntry(storePath, upper.childSessionKey, path.join(testWorkspaceDir, "Tree"));
    await seedSessionEntry(storePath, lower.childSessionKey, path.join(testWorkspaceDir, "tree"));
    const cfg: OpenClawConfig = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const list = await buildSubagentListForTests({
        cfg,
        runs: [upper, lower],
        recentMinutes: 30,
      });

      expect(list.active).toHaveLength(2);
      expect(list.sharedCwdGroupTotal).toBe(0);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
