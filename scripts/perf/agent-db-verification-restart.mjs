/**
 * Synthetic verification/revocation/clean-close cycle at the database owner.
 * Seed with derived-index-admission-measure.ts --mode seed (10k sessions).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-db-verification-restart.mjs --root <seed>
 * Run serial A/A then AB/BA samples. Acceptance: completed proof after revocation,
 * a clean-close seal, and zero successor full checks. Unverified closes stay unsealed.
 * Warm APFS measurements are not btrfs or complete Gateway readiness measurements.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    allocation: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
  },
});
assert(values.root);
const root = fs.realpathSync(values.root);
assert(fs.existsSync(path.join(root, "seed-proof.json")), "Synthetic seed required");
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_LOG_LEVEL = "silent";
const options = { agentId: "main", path: path.join(root, "agent.sqlite"), env: { ...process.env } };
const owner = await import("../../src/state/openclaw-agent-db.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const admission = await import("../../src/infra/sqlite-database-admission.ts");
const validation = await import("../../src/state/openclaw-agent-db-validation-cache.ts");
const { readDatabasePathIdentitySync } = await import("../../src/infra/sqlite-worker-identity.ts");
const { prepareAgentDatabaseStartupVerification } =
  await import("../../src/state/agent-database-startup-integrity.ts");
const { verifyAgentDatabaseStartupIntegrity } =
  await import("../../src/state/agent-database-startup-verification.ts");
const { createPermitPool } = await import("../../src/shared/permit-pool.ts");
const controller = new AbortController();
const permits = createPermitPool(1);
let fullChecks = 0;
const activation = {
  isCurrent: () => true,
  verifyIntegrity: async (input) => {
    fullChecks++;
    await verifyAgentDatabaseStartupIntegrity(input);
  },
};
const prepare = () => {
  const identity = readDatabasePathIdentitySync(options.path);
  return prepareAgentDatabaseStartupVerification(
    {
      agentId: options.agentId,
      paths: [options.path],
      env: options.env,
      signal: controller.signal,
    },
    activation,
    permits,
    {
      ...options,
      identity: identity.key.slice(5),
      birthtime: identity.birthtime,
      integrityVerifiedAt: admission.readSqliteDatabaseIntegrityVerification(options.path)
        ?.verifiedAt,
    },
  );
};
const inspector = new Session();
try {
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const openStart = performance.now();
  const openCpu = process.cpuUsage();
  const db = owner.openOpenClawAgentDatabase(options);
  const sessions = db.db.prepare("SELECT count(*) AS n FROM session_nodes").get().n;
  assert(sessions >= 10000);
  if (values.restart) {
    const inherited = Boolean(admission.readSqliteDatabaseIntegrityVerification(db.db));
    await prepare().verify();
    await owner.closeOpenClawAgentDatabasesAsync(root);
    const cpu = process.cpuUsage(openCpu);
    let allocatedBytes;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
      allocatedBytes = sum(profile.head);
      inspector.disconnect();
    }
    console.log(
      JSON.stringify({
        restart: true,
        inherited,
        fullChecks,
        elapsedMs: performance.now() - openStart,
        cpuMs: (cpu.user + cpu.system) / 1000,
        allocatedBytes,
        peakRssKiB: process.resourceUsage().maxRSS,
        seal: fs.existsSync(`${options.path}.seal`),
      }),
    );
  } else {
    if (values.allocation) {
      await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
    }
    // Reuse the seed's real completed proof; only an unsealed seed needs an initial check.
    const start = performance.now();
    await prepare().verify();
    const initialVerificationMs = performance.now() - start;
    assert(admission.readSqliteDatabaseIntegrityVerification(options.path));
    await owner.closeOpenClawAgentDatabasesAsync(root);
    assert(fs.existsSync(`${options.path}.seal`));
    // The public revocation boundary models an uncertified worker retirement.
    admission.revokeSqliteDatabaseAdmissionsForPath(options.path);
    validation.invalidateOpenClawAgentDatabaseValidation(options.path);
    assert(!admission.readSqliteDatabaseIntegrityVerification(options.path));
    const cpu = process.cpuUsage();
    const before = performance.now();
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    owner.openOpenClawAgentDatabase(options);
    await prepare().verify();
    const verified = Boolean(admission.readSqliteDatabaseIntegrityVerification(options.path));
    await owner.closeOpenClawAgentDatabasesAsync(root);
    const recoveryMs = performance.now() - before;
    const used = process.cpuUsage(cpu);
    let allocatedBytes;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node) => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
      allocatedBytes = sum(profile.head);
      inspector.disconnect();
    }
    const seal = fs.existsSync(`${options.path}.seal`);
    admission.retireSqliteDatabaseAdmissionForPath(options.path);
    validation.clearOpenClawAgentDatabaseValidationCache(options.path);
    const successorStart = performance.now();
    const successor = owner.openOpenClawAgentDatabase(options);
    const successorVerified = Boolean(
      admission.readSqliteDatabaseIntegrityVerification(successor.db),
    );
    const successorOpenMs = performance.now() - successorStart;
    assert.equal(successor.db.prepare("SELECT count(*) AS n FROM session_nodes").get().n, sessions);
    await owner.closeOpenClawAgentDatabasesAsync(root);
    await state.closeOpenClawStateDatabaseAsync();
    const restarts = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const child = spawnSync(
        process.execPath,
        [
          ...process.execArgv,
          process.argv[1],
          "--root",
          root,
          "--restart",
          ...(values.allocation ? ["--allocation"] : []),
        ],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 0, child.stderr);
      restarts.push(JSON.parse(child.stdout.trim().split("\n").at(-1)));
    }
    console.log(
      JSON.stringify({
        bytes: fs.statSync(options.path).size,
        sessions,
        fullChecks,
        initialVerificationMs,
        recoveryMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        peakRssKiB: process.resourceUsage().maxRSS,
        hostLoad: loadavg(),
        verified,
        seal,
        successorVerified,
        successorOpenMs,
        restarts,
      }),
    );
  }
} finally {
  controller.abort();
  await owner.closeOpenClawAgentDatabasesAsync(root);
  await state.closeOpenClawStateDatabaseAsync();
}
