import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRequestNativeSubagentRuntime } from "./plugin-native-subagent.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "./subagents/registry/subagent-registry-state.js";
import {
  isReleasedSubagentRunRecord,
  releasedSubagentPayloadFilter,
} from "./subagents/registry/subagent-registry.store.released-reader.test-support.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import { createSpawnOperatorSource } from "./subagents/spawn/subagent-spawn.production-boundary.test-support.js";

function record(id: string, patch: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: id,
    childSessionKey: "agent:main:subagent:" + id,
    childAgentId: "main",
    requesterAgentId: "main",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    completionRequesterSessionId: "parent-session",
    completionRequesterLifecycleRevision: "parent-revision",
    task: "private task not returned",
    cleanup: "keep",
    createdAt: 100,
    execution: { status: "terminal", endedAt: 200 },
    completion: { required: false, resultText: "private result not returned" },
    delivery: { status: "not_required" },
    collect: true,
    collectorCompletion: { status: "done" },
    nativePluginOwner: {
      version: 1,
      pluginId: "test-plugin",
      requesterProfileId: "spawn-operator",
      requestId: "request-" + id,
    },
    ...patch,
  };
}

/** Drop process-resident registry state and the database handle, as a Gateway restart does. */
function restartRegistryProcess() {
  closeOpenClawStateDatabaseForTest();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
}

/** Read the state file the way the frozen released reader selects and parses rows. */
function readWithReleasedReader(databasePath: string) {
  const older = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = executeSqliteQuerySync(
      older,
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "subagent_runs">>(older)
        .selectFrom("subagent_runs")
        .selectAll()
        .where(releasedSubagentPayloadFilter()),
    ).rows;
    return new Map(
      rows.flatMap((row) => {
        const payload: unknown = JSON.parse(row.payload_json);
        return isReleasedSubagentRunRecord(payload) ? [[row.run_id, payload] as const] : [];
      }),
    );
  } finally {
    older.close();
  }
}

async function withListing(
  run: (
    list: NonNullable<ReturnType<typeof createRequestNativeSubagentRuntime>["list"]>,
  ) => Promise<void>,
) {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      subagentRuns.clear();
      clearSubagentRunsReadCacheForTest();
      const source = createSpawnOperatorSource();
      const cfg = { tools: { swarm: { enabled: true } } };
      setRuntimeConfigSnapshot(cfg);
      try {
        await withPluginRuntimeGatewayRequestScope(
          {
            // SAFETY: Listing prepares native tools but never calls Gateway methods.
            resolveGatewayContext: () => ({}) as GatewayRequestContext,
            isWebchatConnect: () => false,
          },
          async () => {
            const native = createRequestNativeSubagentRuntime(
              {
                options: {
                  config: cfg,
                  agentId: "main",
                  sessionKey: "agent:main:main",
                  sessionId: "parent-session",
                  runId: "recovery-turn",
                  runtimeToolAllowlist: ["agents_wait"],
                  inheritRuntimeToolAllowlist: true,
                },
                lifecycleRevision: "parent-revision",
                operatorAuthority: source.authority,
                assertCurrent: source.authority.assertCurrent,
                prepareSpawn: async () => {
                  throw new Error("listing must not admit a new spawn");
                },
              },
              { pluginId: "test-plugin", assertCurrent: source.authority.assertCurrent },
            );
            await run(expectDefined(native.list, "native list"));
          },
        );
      } finally {
        source.closeRequest();
        source.revoke();
        subagentRuns.clear();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
}

export function registerNativePluginListCases() {
  describe("persisted native plugin child listing", () => {
    it("hydrates canonical custody, excludes legacy and unrelated owners, and returns no private payload", async () => {
      await withListing(async (list) => {
        const future = record("future-owner-version");
        Reflect.set(expectDefined(future.nativePluginOwner, "future owner fixture"), "version", 2);
        const rows = [
          future,
          record("accepted", { label: "review" }),
          record("legacy", { nativePluginOwner: undefined }),
          record("reset", { completionRequesterSessionId: "old-session" }),
          record("old-revision", { completionRequesterLifecycleRevision: "old-revision" }),
          record("missing-parent", { completionRequesterSessionId: undefined }),
          record("other-parent", { requesterSessionKey: "agent:main:other" }),
          record("other-agent", { requesterAgentId: "other" }),
          record("other-plugin", {
            nativePluginOwner: {
              version: 1,
              pluginId: "other",
              requesterProfileId: "spawn-operator",
              requestId: "same",
            },
          }),
          record("other-requester", {
            nativePluginOwner: {
              version: 1,
              pluginId: "test-plugin",
              requesterProfileId: "other",
              requestId: "same",
            },
          }),
          record("ordinary", { collect: false }),
          record("stale", { childSessionKey: "agent:main:subagent:reused" }),
          record("replacement", {
            childSessionKey: "agent:main:subagent:reused",
            createdAt: 300,
            requesterSessionKey: "agent:main:other",
          }),
        ];
        saveSubagentRegistryToSqlite(new Map(rows.map((row) => [row.runId, row])));
        expect(subagentRuns.size).toBe(0);
        expect(await list()).toEqual([
          {
            runId: "accepted",
            childSessionKey: "agent:main:subagent:accepted",
            requestId: "request-accepted",
            label: "review",
            status: "done",
          },
        ]);
      });
    });

    it("keeps stored registry rows compatible across upgrade, rollback and restart", async () => {
      await withListing(async (list) => {
        // A row written before this feature has no ownership field.
        const preFeature = record("pre-feature", { nativePluginOwner: undefined });
        const owned = record("owned");
        saveSubagentRegistryToSqlite(
          new Map([
            [preFeature.runId, preFeature],
            [owned.runId, owned],
          ]),
        );
        const databasePath = openOpenClawStateDatabase().path;
        const recovered = [
          {
            runId: "owned",
            childSessionKey: "agent:main:subagent:owned",
            requestId: "request-owned",
            status: "done",
          },
        ];
        restartRegistryProcess();
        const stored = loadSubagentRegistryFromSqlite();
        expect(stored.get("pre-feature")).toEqual(preFeature);
        expect(stored.get("pre-feature")).not.toHaveProperty("nativePluginOwner");
        expect(stored.get("owned")).toEqual(owned);
        expect(await list()).toEqual(recovered);

        // The released reader still selects both rows, and its full snapshot rewrite keeps ownership.
        const released = readWithReleasedReader(databasePath);
        expect([...released.keys()].toSorted()).toEqual(["owned", "pre-feature"]);
        expect(released.get("owned")).toMatchObject({ nativePluginOwner: owned.nativePluginOwner });
        restartRegistryProcess();
        saveSubagentRegistryToSqlite(released);
        restartRegistryProcess();
        expect(loadSubagentRegistryFromSqlite().get("owned")?.nativePluginOwner).toEqual(
          owned.nativePluginOwner,
        );
        expect(await list()).toEqual(recovered);
      });
    });

    it("filters before the deterministic 200-entry bound and distinguishes execution from completion", async () => {
      await withListing(async (list) => {
        const rows = Array.from({ length: 205 }, (_, i) =>
          record("done-" + i, { createdAt: 1_000 + i }),
        );
        rows.push(
          // Code-unit order puts "B" before "a"; locale or internal-ID order would not.
          record("internal-z", { createdAt: 2_000, swarmRunId: "B" }),
          record("internal-a", { createdAt: 2_000, swarmRunId: "a" }),
          record("pending", {
            createdAt: 1,
            execution: { status: "queued" },
            collectorCompletion: undefined,
          }),
          record("terminal-only", { createdAt: 2, collectorCompletion: undefined }),
        );
        saveSubagentRegistryToSqlite(new Map(rows.map((row) => [row.runId, row])));
        await expect(list({ status: "Done" as "done" })).rejects.toThrow(
          "Unknown native subagent status",
        );
        const window = await list();
        expect(window).toHaveLength(200);
        expect(window.slice(0, 2).map((row) => row.runId)).toEqual(["B", "a"]);
        expect(window[2]?.runId).toBe("done-204");
        expect(window.at(-1)?.runId).toBe("done-7");
        expect(await list({ status: "queued" })).toEqual([
          {
            runId: "pending",
            childSessionKey: "agent:main:subagent:pending",
            requestId: "request-pending",
            status: "queued",
          },
        ]);
        expect(await list({ status: "terminal" })).toEqual([
          {
            runId: "terminal-only",
            childSessionKey: "agent:main:subagent:terminal-only",
            requestId: "request-terminal-only",
            status: "terminal",
          },
        ]);
      });
    });
  });
}
