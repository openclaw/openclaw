import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { resetConfigRuntimeState } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { loadSessionTranscriptEvents } from "../../../config/sessions/session-transcript-events.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { createOperatorRecoveryFixture } from "../../../gateway/operator-run-recovery.test-support.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { persistDevicePairingStoreState } from "../../../infra/device-pairing-store.js";
import type { PairedDevice } from "../../../infra/device-pairing.types.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { appendDeniedSubagentRecoveryNotice } from "./subagent-registry-recovery-notice.js";
import {
  getUnrestorableSubagentCompletionSourceReason,
  restoreSubagentRequesterSource,
} from "./subagent-registry-requester-source.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRestoredRequesterWakeRunnable } from "./subagent-restored-wake-readiness.js";

type Case = {
  runId: string;
  profileId: string;
  expected: "restored" | "denied";
  childEntry: InternalSessionEntry;
};
type Manifest = {
  writerPid: number;
  root: string;
  stateDir: string;
  envVars: Record<string, string | null>;
  cases: Case[];
  device: PairedDevice;
};
const phase = process.env.OPENCLAW_COLD_PROCESS_PHASE;
const manifestPath = process.env.OPENCLAW_COLD_PROCESS_MANIFEST;
const file = "src/agents/subagents/registry/subagent-registry-cold-process.test.ts";
const messageEvents = async (row: SubagentRunRecord, entry: InternalSessionEntry) =>
  (
    await loadSessionTranscriptEvents({
      agentId: "main",
      sessionKey: row.childSessionKey,
      storePath: row.requesterStorePath,
      sessionId: entry.sessionId,
    })
  ).filter((event) => isRecord(event) && event.type === "message");

if (!phase) {
  it("restores custody and fails closed across exited writer and two fresh native reader processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cold-process-"));
    const manifest = path.join(root, "manifest.json");
    const outputs: Record<string, string> = {};
    let stateRoot: string | undefined;
    try {
      for (const name of ["write", "recover", "repeat"] as const) {
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          ["scripts/run-vitest.mjs", file, "--maxWorkers=1"],
          {
            cwd: process.cwd(),
            timeout: 150_000,
            maxBuffer: 4 * 1024 * 1024,
            env: {
              ...process.env,
              OPENCLAW_COLD_PROCESS_PHASE: name,
              OPENCLAW_COLD_PROCESS_MANIFEST: manifest,
            },
          },
        );
        outputs[name] = stdout + stderr;
        if (process.env.OPENCLAW_COLD_PROCESS_REPORT) {
          await fs.writeFile(
            process.env.OPENCLAW_COLD_PROCESS_REPORT + "." + name + ".log",
            outputs[name],
          );
        }
        expect(outputs[name]).toContain("1 passed");
        if (name === "write") {
          const data = JSON.parse(await fs.readFile(manifest, "utf8")) as Manifest;
          stateRoot = data.root;
          expect(() => process.kill(data.writerPid, 0)).toThrow();
        }
      }
      const written = JSON.parse(await fs.readFile(manifest, "utf8")) as Manifest;
      const recovered = JSON.parse(await fs.readFile(manifest + ".recover.json", "utf8")) as {
        pid: number;
        restored: number;
        denied: number;
        notices: number;
        readiness: number;
      };
      const repeated = JSON.parse(
        await fs.readFile(manifest + ".repeat.json", "utf8"),
      ) as typeof recovered;
      expect(new Set([written.writerPid, recovered.pid, repeated.pid]).size).toBe(3);
      expect(recovered).toMatchObject({ restored: 2, denied: 5, notices: 5, readiness: 6 });
      expect(repeated).toMatchObject({ restored: 2, denied: 5, notices: 5, readiness: 6 });
      console.info(
        "COLD_PROCESS_PROOF",
        JSON.stringify({ writerPid: written.writerPid, recovered, repeated }),
      );
      if (process.env.OPENCLAW_COLD_PROCESS_REPORT) {
        await fs.writeFile(
          process.env.OPENCLAW_COLD_PROCESS_REPORT,
          JSON.stringify({ writerPid: written.writerPid, recovered, repeated, outputs }, null, 2),
        );
      }
    } finally {
      if (stateRoot) {
        await fs.rm(stateRoot, { recursive: true, force: true });
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 480_000);
} else {
  it(
    "runs only the isolated " + phase + " process phase",
    async () => {
      expect(manifestPath).toBeTruthy();
      if (!manifestPath) {
        throw new Error("Missing explicit cold-process manifest");
      }
      if (phase === "write") {
        // Keep durable state in the living supervisor root, not the writer test environment's exit-cleaned temporary directory.
        process.env.TMPDIR = path.dirname(manifestPath);
        const state = await createOpenClawTestState({ scenario: "minimal", label: "cold-process" });
        const device: PairedDevice = {
          deviceId: "cold-device",
          publicKey: "cold-public-key",
          roles: ["operator"],
          approvedScopes: ["operator.admin"],
          tokens: {
            operator: {
              token: "synthetic-cold-token",
              role: "operator",
              scopes: ["operator.admin"],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        };
        const rows = new Map<string, SubagentRunRecord>();
        const cases: Case[] = [];
        try {
          for (const runId of [
            "ordinary",
            "collector",
            "revoked",
            "cron",
            "cron-collector",
            "channel",
            "channel-collector",
          ]) {
            const profile = ensureProfileForEmail(runId + "@cold.example.test");
            const isNonOperator = runId.startsWith("cron") || runId.startsWith("channel");
            const requesterKey = runId.startsWith("cron")
              ? "agent:main:cron:" + runId + ":run:test"
              : runId.startsWith("channel")
                ? "agent:main:discord:channel:" + runId
                : "agent:main:requester-" + runId;
            const fixture = isNonOperator
              ? {
                  target: {
                    agentId: "main",
                    sessionKey: requesterKey,
                    storePath: path.join(
                      state.stateDir,
                      "agents",
                      "main",
                      "sessions",
                      "sessions.json",
                    ),
                    sourceRunId: "source-" + runId,
                  },
                  entry: {
                    sessionId: "requester-session-" + runId,
                    lifecycleRevision: "requester-revision-" + runId,
                    createdActor: { type: "system" },
                    updatedAt: 1,
                  } satisfies InternalSessionEntry,
                }
              : await createOperatorRecoveryFixture({
                  stateDir: state.stateDir,
                  context: createContext(),
                  profileId: profile.id,
                  config: {},
                  sourceIngress: "internal",
                  sessionKey: requesterKey,
                  sessionId: "requester-session-" + runId,
                  ...(runId === "revoked" ? { device } : {}),
                });
            const childSessionKey = "agent:main:subagent:" + runId;
            const childEntry: InternalSessionEntry = {
              sessionId: "child-session-" + runId,
              lifecycleRevision: "child-revision-" + runId,
              status: "interrupted",
              lastRunId: runId,
              lifecycleRunId: runId,
              updatedAt: 1,
            };
            await replaceSessionEntry(
              { agentId: "main", sessionKey: childSessionKey, storePath: fixture.target.storePath },
              childEntry,
            );
            if (isNonOperator) {
              // Durable source absence is deliberate. Attribution is not a recovered grant.
              await replaceSessionEntry(fixture.target, {
                ...fixture.entry,
                restartRecoveryOperatorSource: undefined,
                createdActor: { type: "system" },
              });
            }
            const row = createSubagentRunRecord({
              runId,
              childAgentId: "main",
              childSessionKey,
              requesterAgentId: "main",
              requesterSessionKey: fixture.target.sessionKey,
              requesterStorePath: fixture.target.storePath,
              requesterTurnRunId: fixture.target.sourceRunId,
              completionRequesterSessionId: fixture.entry.sessionId,
              completionRequesterLifecycleRevision: fixture.entry.lifecycleRevision,
              operatorRecoverySource: isNonOperator
                ? undefined
                : "restartRecoveryOperatorSource" in fixture.entry
                  ? fixture.entry.restartRecoveryOperatorSource
                  : undefined,
              completionAuthorityRequired: true,
              collect: runId.endsWith("collector"),
              requesterOrigin: runId.startsWith("channel")
                ? {
                    channel: "discord",
                    to: "synthetic-channel",
                    accountId: "synthetic-account",
                  }
                : undefined,
            });
            rows.set(runId, row);
            cases.push({
              runId,
              profileId: profile.id,
              childEntry,
              expected: isNonOperator || runId === "revoked" ? "denied" : "restored",
            });
          }
          const ready = (runId: string, extra: Partial<SubagentRunRecord> = {}) =>
            createSubagentRunRecord({
              runId,
              childAgentId: "main",
              childSessionKey: "agent:main:subagent:" + runId,
              requesterAgentId: "main",
              requesterSessionKey: "agent:main:readiness",
              requesterSettleWake: { status: "dispatching", attemptCount: 1, rearmGeneration: 0 },
              execution: { status: "terminal", startedAt: 1, endedAt: 2 },
              ...extra,
            });
          for (const row of [
            ready("ready"),
            ready("tombstone", {
              requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 0 },
            }),
            ready("paused", {
              pauseReason: "sessions_yield",
              requesterSettleWake: {
                status: "dispatching",
                attemptCount: 1,
                rearmGeneration: 0,
                pauseNotice: { acknowledgment: "Paused" },
              },
            }),
            ready("parent"),
            ready("descendant", {
              requesterSessionKey: "agent:main:subagent:parent",
              execution: { status: "running", startedAt: 1 },
            }),
          ]) {
            rows.set(row.runId, row);
          }
          saveSubagentRegistryToSqlite(rows);
          console.info("COLD_DB_DIAGNOSTIC", {
            selected: openOpenClawStateDatabase().path,
            expected: resolveOpenClawStateSqlitePath(),
            loaded: loadSubagentRegistryFromSqlite().size,
          });
          using peer = new DatabaseSync(resolveOpenClawStateSqlitePath(), { readOnly: true });
          console.info(
            "COLD_RAW_BEFORE",
            peer.prepare("SELECT COUNT(*) AS count FROM subagent_runs").get(),
          );
          await fs.writeFile(
            manifestPath,
            JSON.stringify({
              writerPid: process.pid,
              root: state.root,
              stateDir: state.stateDir,
              envVars: Object.fromEntries(
                Object.entries(state.envVars).map(([key, value]) => [key, value ?? null]),
              ),
              cases,
              device,
            } satisfies Manifest),
          );
        } finally {
          const filename = resolveOpenClawStateSqlitePath();
          await state.restoreEnv(); // Drains native DB owners without deleting durable state.
          using disk = new DatabaseSync(filename, { readOnly: true });
          console.info(
            "COLD_RAW_AFTER",
            disk.prepare("SELECT COUNT(*) AS count FROM subagent_runs").get(),
          );
          console.info("COLD_WRITE_PATH", filename);
        }
        return;
      }
      if (phase !== "recover" && phase !== "repeat") {
        throw new Error("Unknown cold-process phase");
      }
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
      expect(process.pid).not.toBe(manifest.writerPid);
      const previousEnv = new Map(
        Object.keys(manifest.envVars).map((key) => [key, process.env[key]]),
      );
      for (const [key, value] of Object.entries(manifest.envVars)) {
        if (value === null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      resetConfigRuntimeState();
      console.info("COLD_READ_PATH", resolveOpenClawStateSqlitePath());
      const context = createContext();
      context.getRuntimeConfig = () => ({});
      let restored = 0,
        denied = 0,
        notices = 0;
      try {
        const device = manifest.device;
        if (!device.tokens?.operator) {
          throw new Error("Missing synthetic operator token");
        }
        device.tokens.operator.revokedAtMs = 2;
        persistDevicePairingStoreState(
          { pendingById: {}, pairedByDeviceId: { [device.deviceId]: device } },
          manifest.stateDir,
          "both",
        );
        const rows = loadSubagentRegistryFromSqlite();
        expect(rows.size).toBe(12);
        expect(subagentRuns.size).toBe(0);
        for (const row of rows.values()) {
          subagentRuns.set(row.runId, row);
        }
        for (const item of manifest.cases) {
          const storedRow = rows.get(item.runId)!;
          const row =
            process.env.OPENCLAW_COLD_PROCESS_NEGATIVE_CONTROL === "missing-source" &&
            item.runId === "ordinary"
              ? { ...storedRow, operatorRecoverySource: undefined }
              : storedRow;
          if (row !== storedRow) {
            subagentRuns.set(row.runId, row);
          }
          const resolver = () => context;
          bindGatewayContextResolver(row, resolver);
          expect(() => subagentRuns.runWithCompletionAuthority(row, () => true)).toThrow(
            "no longer active",
          );
          await restoreSubagentRequesterSource(row, resolver, () => true);
          const reason = getUnrestorableSubagentCompletionSourceReason(row);
          if (item.expected === "restored") {
            expect(reason).toBeUndefined();
            expect(
              subagentRuns.runWithCompletionAuthority(
                row,
                () =>
                  getPluginRuntimeGatewayRequestScope()?.client?.authenticatedUserProfile
                    ?.profileId,
              ),
            ).toBe(item.profileId);
            restored++;
          } else {
            expect(reason).toBeTruthy();
            if (item.runId === "revoked") {
              expect(reason).toBe("The original requester source is no longer authorized");
            } else {
              expect(reason).toContain("no restorable authentication source");
            }
            expect(() => subagentRuns.runWithCompletionAuthority(row, () => true)).toThrow(
              "no longer active",
            );
            const args = {
              runId: row.runId,
              reason,
              agentId: "main",
              sessionKey: row.childSessionKey,
              storePath: row.requesterStorePath,
              entry: item.childEntry,
              suppressSessionEffects: false,
              assertCurrent() {},
            };
            await appendDeniedSubagentRecoveryNotice(args);
            await appendDeniedSubagentRecoveryNotice(args);
            const events = await messageEvents(row, item.childEntry);
            expect(events).toHaveLength(1);
            notices += events.length;
            denied++;
          }
          const parentEvents = await loadSessionTranscriptEvents({
            agentId: "main",
            sessionKey: row.requesterSessionKey,
            storePath: row.requesterStorePath,
            sessionId: row.completionRequesterSessionId!,
          });
          expect(
            parentEvents.filter((event) => isRecord(event) && event.type === "message"),
          ).toHaveLength(0);
        }
        const ready = rows.get("ready")!,
          tombstone = rows.get("tombstone")!,
          paused = rows.get("paused")!,
          parent = rows.get("parent")!,
          descendant = rows.get("descendant")!;
        expect(isRestoredRequesterWakeRunnable(ready, [ready], false)).toBe(true);
        expect(isRestoredRequesterWakeRunnable(tombstone, [tombstone], false)).toBe(false);
        expect(isRestoredRequesterWakeRunnable(paused, [paused], false)).toBe(false);
        expect(isRestoredRequesterWakeRunnable(paused, [paused], true)).toBe(true);
        expect(isRestoredRequesterWakeRunnable(parent, [parent, descendant], false)).toBe(false);
        const settledDescendant = {
          ...descendant,
          execution: { status: "terminal" as const, startedAt: 1, endedAt: 3 },
        };
        expect(isRestoredRequesterWakeRunnable(parent, [parent, settledDescendant], false)).toBe(
          true,
        );
        await fs.writeFile(
          manifestPath + "." + phase + ".json",
          JSON.stringify({ pid: process.pid, restored, denied, notices, readiness: 6 }),
        );
      } finally {
        await cleanupSessionStateForTest({ stateDir: manifest.stateDir, rootPath: manifest.root });
        for (const [key, value] of previousEnv) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        resetConfigRuntimeState();
      }
    },
    120_000,
  );
}
