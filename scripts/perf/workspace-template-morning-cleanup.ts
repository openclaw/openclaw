/** Retire only this synthetic morning arm through the existing lifecycle owners. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { ManagedWorktreeService } from "../../src/agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../../src/agents/worktrees/types.js";

export async function cleanupMorningWorktrees(params: {
  service: ManagedWorktreeService;
  worktrees: ManagedWorktreeRecord[];
  sessions: Array<{ sessionKey: string; sessionId: string }>;
}) {
  const { replaceSessionEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
  const { listTemplatesAsync } =
    await import("../../src/agents/worktrees/template-registry-async.js");
  const { collectWorktreeTemplates } = await import("../../src/agents/worktrees/template-cache.js");
  const { readRegistry } = await import("../../src/agents/sandbox/registry.js");
  const { retireSandboxDependencyBuilder } =
    await import("../../src/agents/sandbox/dependency-template.js");
  const { readWorktreeCleanupState } = await import("../../src/agents/worktrees/registry-read.js");
  const { hasLocalWorkspaceProjection } =
    await import("../../src/gateway/worker-environments/local-workspace-store.js");
  const { withWorktreeAllocationLease } = await import("../../src/agents/worktrees/allocation.js");
  const { retireExpiredManagedWorktreeSnapshot } =
    await import("../../src/agents/worktrees/snapshot-host.js");
  const repositories = new Set(params.worktrees.map((record) => record.repoRoot));
  const templates = (await listTemplatesAsync(process.env)).filter((record) =>
    repositories.has(record.repoRoot),
  );
  const templatePaths = new Set(templates.map((record) => record.path));
  for (const { sessionKey, sessionId } of params.sessions) {
    assert(sessionKey.startsWith("agent:fixture:morning-"));
    await replaceSessionEntry(
      { agentId: "fixture", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  }
  for (const { id } of params.worktrees) {
    const result = await params.service.remove({ id, reason: "synthetic morning arm completed" });
    assert(result.removed, `Synthetic worktree ${id} retained during teardown`);
    await withWorktreeAllocationLease({ env: process.env }, async (guard) => {
      assert(
        await retireExpiredManagedWorktreeSnapshot({
          env: process.env,
          id,
          expiresBefore: Date.now() + 1,
          guard,
        }),
      );
    });
    assert.equal(await hasLocalWorkspaceProjection(id, process.env), false);
  }
  for (const entry of (await readRegistry({ env: process.env })).entries) {
    if (entry.workspaceDir && templatePaths.has(entry.workspaceDir)) {
      await retireSandboxDependencyBuilder(entry, () => {}, true);
    }
  }
  const scopes = new Map(
    templates.map((record) => [JSON.stringify([record.commonDir, record.worktreeRoot]), record]),
  );
  const before = Date.now() + 1;
  for (const scope of scopes.values()) {
    await collectWorktreeTemplates(process.env, before, { scope, commitGuard: () => {} });
  }
  const state = await readWorktreeCleanupState(process.env);
  const remainingTemplates = await listTemplatesAsync(process.env);
  const remainingBuilders = (await readRegistry({ env: process.env })).entries;
  const liveWorktrees = state.records.filter((record) => record.removedAt === undefined);
  assert.equal(liveWorktrees.length, 0);
  assert.equal(remainingTemplates.length, 0, "A template or its reader/build custody remains");
  assert.equal(remainingBuilders.length, 0, "A sandbox runtime remains");
  assert.deepEqual(state.leases.liveScopes, []);
  assert.deepEqual(state.leases.staleScopes, []);
  return {
    removedWorktrees: params.worktrees.length,
    detachedSessions: params.sessions.length,
    retiredWorktreeRecords: state.records.length,
    liveWorktrees: liveWorktrees.length,
    templates: remainingTemplates.length,
    builders: remainingBuilders.length,
    liveRunScopes: state.leases.liveScopes.length,
  };
}

/** Offline fixture audit: call only after agent/state owners and singleton work have closed. */
export async function verifyMorningWorktreeCleanup(stateDir: string) {
  const { resolveOpenClawStateSqlitePath } =
    await import("../../src/state/openclaw-state-db.paths.js");
  using db = new DatabaseSync(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
    { readOnly: true },
  );
  const counts: Record<string, number> = {};
  for (const table of [
    "worktrees",
    "worktree_templates",
    "local_workspace_projections",
    "sandbox_registry_entries",
    "state_leases",
  ]) {
    const value = db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count;
    assert(typeof value === "number" && Number.isSafeInteger(value));
    assert.equal(value, 0, `Synthetic morning teardown retained ${table}`);
    counts[table] = value;
  }
  return counts;
}
