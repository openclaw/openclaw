// Synthetic update-owner benchmark; run with node --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    samples: { type: "string", default: "5" },
    phase: { type: "string" },
  },
});
assert.ok(values.baseline, "Use --baseline <git-ref> [--samples 5]");
const samples = Number(values.samples);
assert.ok(
  Number.isSafeInteger(samples) && samples >= 3 && samples % 2 === 1,
  "Use an odd sample count >=3",
);
if (values.phase === "discovery") {
  await measureDiscovery();
  process.exit(0);
}
const phases = values.phase ? [values.phase] : ["snapshot", "retention", "doctor"];
assert.ok(phases.every((phase) => ["snapshot", "retention", "doctor"].includes(phase)));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "openclaw-update-io-")));
fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
for (const name of ["home", "state", "cache"]) {
  fs.mkdirSync(path.join(root, name));
}
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  XDG_CACHE_HOME: path.join(root, "cache"),
});

try {
  await measure();
} finally {
  const { closeCliResources, waitForPendingCliDisposers } =
    await import("../../src/cli/runtime-cleanup.js");
  await closeCliResources();
  await waitForPendingCliDisposers();
  fs.rmSync(root, { recursive: true, force: true });
}

async function measure() {
  const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.js");
  const template = openOpenClawStateDatabase();
  const templatePath = template.path;
  const { borrowOpenClawAgentDatabase } = await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db-lifecycle.js");
  for (const agentId of ["bench-a", "bench-b"]) {
    const borrowed = borrowOpenClawAgentDatabase({ agentId });
    borrowed.release();
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const { buildUpdateRehearsalPathEnv } = await import("../../src/infra/update-rehearsal-paths.js");
  const env = {
    ...process.env,
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
  };
  Object.assign(process.env, env);
  const listener = net.createServer();
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({
      gateway: { mode: "local", port },
      plugins: { enabled: false },
      agents: { ownership: "explicit", entries: { "bench-a": {}, "bench-b": {} } },
    }),
  );
  const files = [1536, 256, 256].map((rows, index) => {
    const file =
      index === 0
        ? templatePath
        : path.join(
            root,
            "agents",
            index === 1 ? "bench-a" : "bench-b",
            "agent",
            "openclaw-agent.sqlite",
          );
    using database = new DatabaseSync(file);
    database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE synthetic_payload(value BLOB); BEGIN");
    const insert = database.prepare("INSERT INTO synthetic_payload VALUES (zeroblob(1048576))");
    for (let row = 0; row < rows; row++) {
      insert.run();
    }
    database.exec("COMMIT");
    return file;
  });
  const runtime = path.join(root, "runtime");
  const pluginPayload = path.join(runtime, "extensions", "synthetic", "payload");
  fs.mkdirSync(pluginPayload, { recursive: true });
  fs.mkdirSync(path.join(runtime, "extensions", "synthetic"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), '{"name":"synthetic-runtime"}');
  fs.writeFileSync(
    path.join(runtime, "extensions", "synthetic", "openclaw.plugin.json"),
    '{"id":"synthetic","configSchema":{"type":"object","properties":{}}}',
  );
  const payload = Buffer.alloc(1024 * 1024, 42);
  for (let index = 0; index < 256; index++) {
    fs.writeFileSync(path.join(pluginPayload, `${index}.bin`), payload, { mode: 0o644 });
  }

  // Freeze the changed snapshot owner; its unchanged dependencies stay in this checkout.
  const owner = path.join(repo, "src/infra/update-candidate-state.ts");
  const baseline = execFileSync(
    "git",
    ["show", `${values.baseline}:src/infra/update-candidate-state.ts`],
    {
      cwd: repo,
      encoding: "utf8",
    },
  ).replace(/(from\s+|import\(\s*)"([^"]+)"/gu, (_match, prefix: string, specifier: string) => {
    const resolved = specifier.startsWith(".")
      ? pathToFileURL(path.resolve(path.dirname(owner), specifier)).href
      : import.meta.resolve(specifier);
    return `${prefix}${JSON.stringify(resolved)}`;
  });
  const frozen = path.join(root, "baseline-snapshot.ts");
  fs.writeFileSync(frozen, baseline);
  const before: typeof import("../../src/infra/update-candidate-state.js") = await import(
    pathToFileURL(frozen).href
  );
  const after = await import("../../src/infra/update-candidate-state.js");
  const { prepareRetainedRuntimeFiles, projectRetainedRuntimePath } =
    await import("../../src/infra/update-retained-runtime-files.js");
  const { sha256File } = await import("../../src/infra/crypto-digest.js");
  const { doctorCommand } = await import("../../src/commands/doctor.js");
  const { ExitError } = await import("../../src/runtime.js");
  const runDoctor = async () => {
    try {
      await doctorCommand(
        {
          log() {},
          error: (...args) => console.error(...args),
          exit: (code) => {
            throw new ExitError(code);
          },
        },
        { repair: true, nonInteractive: true, workspaceSuggestions: false },
      );
    } catch (error) {
      if (!(error instanceof ExitError && error.code === 0)) {
        throw error;
      }
    }
  };
  // Converge setup repairs before paired, warm measurements.
  if (phases.includes("doctor")) {
    await runDoctor();
  }
  const measurements: Array<{ label: string; phase: string; seconds: number }> = [];
  console.log(
    JSON.stringify({
      baseline: execFileSync("git", ["rev-parse", values.baseline ?? "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
      candidateOwnerSha256: createHash("sha256").update(fs.readFileSync(owner)).digest("hex"),
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      node: process.version,
      platform: process.platform,
      samples,
      sqliteBytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
      pluginBytes: payload.length * 256,
      loadavg: loadavg(),
      scope:
        "Inventory + candidate snapshot, runtime retention, full candidate Doctor. Warm filesystem, ABAB order; not total update downtime.",
      acceptance:
        "Exact payloads and full output integrity; eliminate inventory's whole-store copy; snapshot median improves >10%; no gain claimed for unchanged retention/Doctor controls.",
    }),
  );
  for (let sample = 0; sample < samples; sample++) {
    for (const phase of phases) {
      for (const [label, snapshotOwner] of [
        ["before", before],
        ["after", after],
      ] as const) {
        const output = path.join(root, `${label}-${sample}-${phase}`);
        fs.mkdirSync(output);
        let inventoryCopies = 0;
        const started = performance.now();
        const snapshots: string[] = [];
        if (phase === "snapshot") {
          const input = {
            stateDir: root,
            targetStateDir: output,
            candidateRoot: repo,
            config: { plugins: { enabled: false } },
            env,
            onProgress: (
              progress: import("../../src/infra/update-candidate-state.diagnostics.js").UpdateStateInspectionProgress,
            ) => {
              if (
                progress.phase === "shared database snapshot" &&
                progress.snapshot?.status === "completed"
              ) {
                inventoryCopies++;
              }
            },
          };
          const inventory = await snapshotOwner.readUpdateCandidateStateInventoryInProcess(input);
          await snapshotOwner.snapshotUpdateCandidateState({
            ...input,
            pluginPlanPath: path.join(output, inventory.pluginPlan),
            databaseInventory: [...inventory.databases.keys()],
          });
          snapshots.push(...files.map((file) => path.join(output, path.relative(root, file))));
        } else if (phase === "retention") {
          const result = await prepareRetainedRuntimeFiles({
            privateRoot: output,
            sourceRoot: runtime,
            roots: [runtime],
            retainedDependencyRoot: runtime,
          });
          assert.ok(!("unusableReason" in result));
          assert.equal(result.linked, 256);
          assert.equal(result.copied, 2);
        } else {
          await runDoctor();
        }
        const seconds = (performance.now() - started) / 1000;
        measurements.push({ label, phase, seconds });
        console.log(
          JSON.stringify({
            label,
            sample,
            phase,
            seconds,
            ...(phase === "snapshot" ? { inventoryCopies } : {}),
          }),
        );
        // Verification is outside timing; never retain all output generations.
        for (const [index, snapshot] of snapshots.entries()) {
          using restored = new DatabaseSync(snapshot, { readOnly: true });
          assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.equal(
            restored
              .prepare(
                "SELECT count(*) AS count FROM synthetic_payload WHERE value=zeroblob(1048576)",
              )
              .get()?.count,
            [1536, 256, 256][index],
          );
        }
        if (phase === "retention") {
          const retained = projectRetainedRuntimePath(output, path.join(pluginPayload, "0.bin"));
          assert.equal(
            await sha256File(retained),
            createHash("sha256").update(payload).digest("hex"),
          );
        }
        fs.rmSync(output, { recursive: true });
      }
    }
  }
  for (const phase of phases) {
    for (const label of ["before", "after"]) {
      const sorted = measurements
        .filter((row) => row.label === label && row.phase === phase)
        .map((row) => row.seconds)
        .toSorted((a, b) => a - b);
      console.log(
        JSON.stringify({
          label,
          phase,
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          min: sorted[0],
          max: sorted.at(-1),
        }),
      );
    }
  }
}

// Owner-only attribution, not total update time or Gateway downtime.
async function measureDiscovery() {
  assert.ok(samples >= 5, "Discovery timing requires at least five interleaved samples");
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = path.join(sourceRoot, ".artifacts");
  fs.mkdirSync(scratch, { recursive: true });
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "update-discovery-")));
  const stateDir = path.join(fixtureRoot, "state");
  const agentRoot = path.join(stateDir, "agents/main/agent");
  const database = path.join(agentRoot, "openclaw-agent.sqlite");
  Object.assign(process.env, {
    HOME: path.join(fixtureRoot, "home"),
    OPENCLAW_HOME: path.join(fixtureRoot, "home"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_AGENT_DIR: agentRoot,
  });
  try {
    fs.mkdirSync(agentRoot, { recursive: true });
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, '{"plugins":{"enabled":false}}');
    {
      using db = new DatabaseSync(database);
      db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('synthetic')");
    }
    for (let directory = 0; directory < 200; directory++) {
      const destination = path.join(agentRoot, `ordinary-${directory}`);
      fs.mkdirSync(destination);
      for (let file = 0; file < 10; file++) {
        fs.writeFileSync(path.join(destination, `${file}.txt`), "ordinary synthetic payload");
      }
    }
    const owners = [
      "src/commands/backup-resource-inventory.ts",
      "src/infra/backup-sqlite-snapshot.ts",
    ];
    const frozenOwners = new Map(
      owners.map((owner) => [
        path.resolve(sourceRoot, owner),
        path.join(fixtureRoot, path.basename(owner)),
      ]),
    );
    for (const relative of owners) {
      const owner = path.resolve(sourceRoot, relative);
      const baseline = execFileSync("git", ["show", `${values.baseline}:${relative}`], {
        cwd: sourceRoot,
        encoding: "utf8",
      }).replace(
        /(from\s+|import\(\s*)"([^"]+)"/gu,
        (_match, prefix: string, specifier: string) => {
          const source = path.resolve(path.dirname(owner), specifier);
          const resolved = specifier.startsWith(".")
            ? pathToFileURL(frozenOwners.get(source.replace(/\.js$/u, ".ts")) ?? source).href
            : import.meta.resolve(specifier);
          return `${prefix}${JSON.stringify(resolved)}`;
        },
      );
      fs.writeFileSync(frozenOwners.get(owner)!, baseline);
    }
    const before: typeof import("../../src/infra/backup-sqlite-snapshot.js") = await import(
      pathToFileURL(frozenOwners.get(path.resolve(sourceRoot, owners[1]!))!).href
    );
    const after = await import("../../src/infra/backup-sqlite-snapshot.js");
    const promises = (await import("node:fs/promises")).default;
    const original = promises.readdir;
    const measurements: Array<{ label: string; seconds: number; unrelatedDirectoryReads: number }> =
      [];
    console.log(
      JSON.stringify({
        scope:
          "Warm discovery owners only; both changed baseline modules frozen, other dependencies shared; not CLI update or downtime proof",
        acceptance:
          "Exact selected core database; zero agent-tree reads outside retained plugin resource roots; candidate median/p95 must not regress",
        baseline: values.baseline,
        samples,
        ordinaryFiles: 2000,
        unrelatedDirectories: 201,
        candidateOwners: Object.fromEntries(
          owners.map((owner) => [
            owner,
            createHash("sha256")
              .update(fs.readFileSync(path.join(sourceRoot, owner)))
              .digest("hex"),
          ]),
        ),
        node: process.version,
        loadavg: loadavg(),
      }),
    );
    // Both owners warm metadata/module caches before the interleaved samples.
    const input = {
      stateDir,
      config: { plugins: { enabled: false } },
      env: process.env,
      agentRegistry: [],
    };
    for (const module of [before, after]) {
      assert.deepEqual(await module.discoverBackupDatabasePaths(input), [database]);
    }
    for (let sample = 0; sample < samples; sample++) {
      for (const [label, module] of [
        ["before", before],
        ["after", after],
      ] as const) {
        let unrelatedDirectoryReads = 0;
        promises.readdir = new Proxy(original, {
          apply(target, thisArg, args) {
            const directory = String(args[0]);
            if (directory === agentRoot || directory.startsWith(`${agentRoot}${path.sep}`)) {
              unrelatedDirectoryReads++;
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        const started = performance.now();
        try {
          assert.deepEqual(await module.discoverBackupDatabasePaths(input), [database]);
        } finally {
          promises.readdir = original;
        }
        const seconds = (performance.now() - started) / 1000;
        measurements.push({ label, seconds, unrelatedDirectoryReads });
        console.log(JSON.stringify({ sample, label, seconds, unrelatedDirectoryReads }));
      }
    }
    for (const label of ["before", "after"]) {
      const rows = measurements.filter((row) => row.label === label);
      assert.ok(rows.every((row) => row.unrelatedDirectoryReads === (label === "after" ? 0 : 201)));
      const times = rows.map((row) => row.seconds).toSorted((a, b) => a - b);
      console.log(
        JSON.stringify({
          label,
          median: times[Math.floor(times.length / 2)],
          p95: times[Math.ceil(times.length * 0.95) - 1],
          min: times[0],
          max: times.at(-1),
          unrelatedDirectoryReads: rows.map((row) => row.unrelatedDirectoryReads),
        }),
      );
    }
  } finally {
    const { closeCliResources, waitForPendingCliDisposers } =
      await import("../../src/cli/runtime-cleanup.js");
    await closeCliResources();
    await waitForPendingCliDisposers();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
