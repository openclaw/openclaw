/**
 * Synthetic legacy-conflict owner proof; no live Gateway or operator state.
 * node --import ./scripts/tsx.mjs scripts/perf/exec-approvals-startup-measure.ts
 *   --prepare /scratch/frozen-owners --base-ref <commit>
 * Seed a production-shaped fixture with bench-gateway-startup.ts --case teamBoot
 * --team-scale --seed-only --fixture-root /scratch/team, then use --seed once.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/exec-approvals-startup-measure.ts
 *   --fixture-root /scratch/team --owner /scratch/frozen-owners/before.mjs
 *   --expect refused --output /scratch/before-1.json
 * Alternate before/after fresh processes at least five times; repeat before/before
 * for A/A controls. Imports, canonical reads, setup and cleanup are not timed.
 * First call and 100 warm calls are separate; filesystem caches are not evicted.
 * Acceptance is refusal -> diagnostic with exact source and canonical preservation.
 * Timing measures completed owner work, not a speedup against a failed Gateway boot.
 * Exact allocation covers the main V8 isolate; CPU covers this process and thread.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    prepare: { type: "string" },
    "base-ref": { type: "string", default: "HEAD" },
    "fixture-root": { type: "string" },
    owner: { type: "string" },
    expect: { type: "string" },
    output: { type: "string" },
    seed: { type: "boolean" },
  },
});
const repository = fileURLToPath(new URL("../..", import.meta.url));
const ownerPath = "src/infra/state-migrations.exec-approvals.ts";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
if (values.prepare) {
  const directory = path.resolve(values.prepare);
  fs.mkdirSync(directory);
  const { build, stop } = await import("esbuild");
  const sources = {
    before: execFileSync("git", ["show", `${values["base-ref"]}:${ownerPath}`], {
      cwd: repository,
      encoding: "utf8",
    }),
    after: fs.readFileSync(path.join(repository, ownerPath), "utf8"),
  };
  for (const [arm, contents] of Object.entries(sources)) {
    await build({
      stdin: {
        contents,
        sourcefile: path.basename(ownerPath),
        resolveDir: path.dirname(path.join(repository, ownerPath)),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(directory, `${arm}.mjs`),
      plugins: [
        {
          name: "retain-owner-peer-imports",
          setup(builder) {
            builder.onResolve({ filter: /./ }, (args) => {
              if (!args.path.startsWith(".")) {
                return { path: import.meta.resolve(args.path), external: true };
              }
              const resolved = path.resolve(args.resolveDir, args.path);
              const typescript = resolved.replace(/\.js$/u, ".ts");
              return { path: fs.existsSync(typescript) ? typescript : resolved, external: true };
            });
          },
        },
      ],
    });
  }
  await stop();
  fs.writeFileSync(
    path.join(directory, "sources.json"),
    JSON.stringify(
      {
        baseCommit: execFileSync("git", ["rev-parse", values["base-ref"]], {
          encoding: "utf8",
        }).trim(),
        sourceHashes: Object.fromEntries(
          Object.entries(sources).map(([arm, source]) => [arm, hash(source)]),
        ),
      },
      null,
      2,
    ),
  );
} else {
  assert(values["fixture-root"], "--fixture-root must be an owned teamBoot synthetic fixture");
  const fixtureRoot = path.resolve(values["fixture-root"]);
  const shape: Record<string, unknown> = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "team-boot-fixture.json"), "utf8"),
  );
  assert(shape.teamScale === true, "Use the existing --team-scale fixture generator");
  const stateDir = path.join(fixtureRoot, "state");
  process.env = {
    PATH: process.env.PATH,
    HOME: fixtureRoot,
    OPENCLAW_HOME: fixtureRoot,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "openclaw.json"),
    NO_COLOR: "1",
  };
  const sourcePath = path.join(stateDir, "exec-approvals.json");
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  if (values.seed) {
    const state = await import("../../src/state/openclaw-state-db.js");
    const { writeExecApprovalsConfigRow } =
      await import("../../src/infra/exec-approvals-sqlite.js");
    try {
      state.runOpenClawStateWriteTransaction(({ db }) =>
        writeExecApprovalsConfigRow({
          db,
          file: { version: 1, defaults: { security: "deny", ask: "off" }, agents: {} },
        }),
      );
    } finally {
      await state.closeOpenClawStateDatabaseAsync();
    }
    const legacy = JSON.stringify({
      version: 1,
      defaults: { security: "full", ask: "off" },
      agents: {},
    });
    fs.writeFileSync(sourcePath, legacy.padEnd(315, " ") + "\n", { flag: "wx", mode: 0o600 });
  } else {
    assert(values.owner && values.output && globalThis.gc);
    assert(values.expect === "refused" || values.expect === "diagnostic");
    const ownerUrl = pathToFileURL(path.resolve(values.owner));
    const owner: typeof import("../../src/infra/state-migrations.exec-approvals.js") = await import(
      ownerUrl.href
    );
    const sourceBefore = fs.readFileSync(sourcePath);
    assert.equal(sourceBefore.byteLength, 316);
    using database = new DatabaseSync(databasePath, { readOnly: true });
    const facts = owner.readLegacyExecApprovalsPreparationFacts(database, sourcePath);
    assert(facts.canonical?.raw_json.includes('"deny"'));
    const allocation = () => {
      const value: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
      assert(typeof value === "number", "Runtime must expose exact V8 allocation counter");
      return value;
    };
    const measure = async (calls: number) => {
      globalThis.gc!();
      const allocated = allocation();
      const cpu = process.cpuUsage();
      const threadCpu = process.threadCpuUsage();
      const started = performance.now();
      let refused = 0;
      let diagnostics = 0;
      for (let index = 0; index < calls; index++) {
        try {
          const result = await owner.prepareLegacyExecApprovals({
            stateDir,
            env: process.env,
            facts,
          });
          assert.equal(result?.code, "legacy-exec-approvals-conflict");
          diagnostics++;
        } catch (error) {
          assert(error instanceof Error && error.name === "ExecApprovalsMigrationRequiredError");
          refused++;
        }
      }
      const wallMs = performance.now() - started;
      const mainThreadCpu = process.threadCpuUsage(threadCpu);
      const processCpu = process.cpuUsage(cpu);
      const allocatedBytes = allocation() - allocated;
      assert.equal(values.expect === "refused" ? refused : diagnostics, calls);
      return {
        calls,
        refused,
        diagnostics,
        wallMs,
        allocatedBytes,
        processCpuMs: (processCpu.user + processCpu.system) / 1000,
        mainThreadCpuMs: (mainThreadCpu.user + mainThreadCpu.system) / 1000,
      };
    };
    const loadBefore = os.loadavg();
    const first = await measure(1);
    const warm = await measure(100);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
    assert.deepEqual(owner.readLegacyExecApprovalsPreparationFacts(database, sourcePath), facts);
    fs.writeFileSync(
      values.output,
      JSON.stringify(
        {
          owner: ownerUrl.href,
          ownerHash: hash(fs.readFileSync(ownerUrl)),
          node: process.version,
          platform: process.platform,
          loadBefore,
          loadAfter: os.loadavg(),
          shape,
          legacyBytes: sourceBefore.byteLength,
          first,
          warm,
          canonicalUnchanged: true,
          legacyUnchanged: true,
        },
        null,
        2,
      ),
    );
  }
}
