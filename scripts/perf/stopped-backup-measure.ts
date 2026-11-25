// Attribution only; the native update crossing remains the end-to-end proof.
// node --import ./scripts/tsx.mjs scripts/perf/update-doctor-generation-measure.ts backup-aa stopped-backup-phases 2 . .local/lane2133/fixture
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

type Event = {
  operation: string;
  startedAt: number;
  durationMs: number;
  userCPUUs: number;
  systemCPUUs: number;
  bytes?: number;
  method?: string;
};

export async function measureStoppedBackupPhases(options: {
  label: string;
  samples: number;
  sourceRoot: string;
  fixture: string | undefined;
  hashSource: (file: string) => string;
}) {
  assert.ok(options.samples <= 2, "Use at most two same-input controls");
  assert.ok(options.fixture, "Supply a marked synthetic schema-crossing fixture");
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "This probe requires macOS arm64",
  );
  const local = fs.realpathSync(path.resolve(".local"));
  assert.ok(
    local.startsWith(fs.realpathSync(process.cwd()) + path.sep),
    ".local must remain inside this checkout",
  );
  const fixture = fs.realpathSync(options.fixture);
  assert.ok(
    fixture.startsWith(local + path.sep),
    "Fixture must remain inside this checkout's .local",
  );
  assert.ok(
    fs.statSync(path.join(fixture, "fixture.json")).isFile(),
    "Missing synthetic fixture marker",
  );
  Object.assign(process.env, {
    HOME: path.join(fixture, "home"),
    OPENCLAW_HOME: path.join(fixture, "home"),
    OPENCLAW_STATE_DIR: path.join(fixture, "state"),
    OPENCLAW_CONFIG_PATH: path.join(fixture, "state", "openclaw.json"),
  });
  const paths = ["state/openclaw.sqlite", "agents/synthetic-0/agent/openclaw-agent.sqlite"].map(
    (name) => fs.realpathSync(path.join(fixture, "state", name)),
  );
  for (const source of paths) {
    assert.ok(source.startsWith(fixture + path.sep), "Synthetic database escaped its fixture");
    assert.ok(!fs.existsSync(`${source}-journal`), "Stopped capture requires no rollback journal");
    assert.equal(
      fs.statSync(`${source}-wal`, { throwIfNoEntry: false })?.size ?? 0,
      0,
      "Drain WAL before capture",
    );
  }
  const sourceRequire = createRequire(path.join(options.sourceRoot, "package.json"));
  const { getFsSafeNativeStatus }: typeof import("@openclaw/fs-safe/config") = await import(
    pathToFileURL(sourceRequire.resolve("@openclaw/fs-safe/config")).href
  );
  const nativeStatus = await getFsSafeNativeStatus({ probe: true });
  assert.ok(
    nativeStatus.loaded && nativeStatus.packageName,
    "Native fs-safe must be enabled and loaded",
  );
  // This pinned version keeps copy and fsync separate; future versions need requalification.
  assert.equal(
    nativeStatus.packageVersion,
    "0.27.0",
    "Requalify native phase boundaries after fs-safe upgrades",
  );
  const nativeRequire = createRequire(sourceRequire.resolve("@openclaw/fs-safe/root"));
  const native: unknown = nativeRequire(nativeStatus.packageName);
  assert.ok(
    native && typeof native === "object" && "copyFileExclusive" in native && "sha256File" in native,
  );
  assert.ok(
    typeof native.copyFileExclusive === "function" && typeof native.sha256File === "function",
  );
  const output = path.join(local, `stopped-backup-${options.label}`);
  fs.mkdirSync(output, { mode: 0o700 }); // Never reuse or remove an existing output directory.
  // Independent bounded-buffer oracle, outside owner timing; it warms source reads.
  const oracleBeforeCPU = process.cpuUsage();
  const oracleBeforeAt = performance.now();
  const sources = paths.map((sourcePath) => ({
    sourcePath,
    identity: fs.statSync(sourcePath, { bigint: true }),
    digest: options.hashSource(sourcePath),
  }));
  const oracleBefore = {
    wallMs: performance.now() - oracleBeforeAt,
    cpuUs: process.cpuUsage(oracleBeforeCPU),
  };
  console.log(JSON.stringify({ phase: "untimed-source-oracle-before", ...oracleBefore }));
  const events: Event[] = [];
  const start = (operation: string) => {
    const cpu = process.cpuUsage();
    const at = performance.now();
    return (details: Pick<Event, "bytes" | "method"> = {}) => {
      const usage = process.cpuUsage(cpu);
      events.push({
        operation,
        startedAt: at,
        durationMs: performance.now() - at,
        userCPUUs: usage.user,
        systemCPUUs: usage.system,
        ...details,
      });
    };
  };
  const copy = native.copyFileExclusive;
  const hash = native.sha256File;
  const fsync = fs.fsync;
  const fsyncSync = fs.fsyncSync;
  const open = fs.promises.open;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forward the SQLite receiver and restore the exact native methods.
  const exec = DatabaseSync.prototype.exec;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forward the SQLite receiver and restore the exact native methods.
  const close = DatabaseSync.prototype.close;
  try {
    native.copyFileExclusive = new Proxy(copy, {
      async apply(target, receiver, args) {
        const bytes = fs.fstatSync(args[0]).size;
        const end = start("native-copy");
        const result = await Reflect.apply(target, receiver, args);
        end({ bytes, method: result.method });
        return result;
      },
    });
    native.sha256File = new Proxy(hash, {
      async apply(target, receiver, args) {
        const end = start("native-sha256");
        const result = await Reflect.apply(target, receiver, args);
        end({ bytes: result.bytes });
        return result;
      },
    });
    fs.fsync = new Proxy(fsync, {
      apply(target, receiver, args) {
        const end = start("fsync-callback");
        const callback: fs.NoParamCallback = args[1];
        return Reflect.apply(target, receiver, [
          args[0],
          (error: NodeJS.ErrnoException | null) => {
            end();
            callback(error);
          },
        ]);
      },
    });
    fs.fsyncSync = (fd) => {
      const end = start("fsync-sync");
      try {
        return fsyncSync(fd);
      } finally {
        end();
      }
    };
    fs.promises.open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        const end = start("filehandle-sync");
        try {
          return await sync();
        } finally {
          end();
        }
      };
      return handle;
    };
    DatabaseSync.prototype.exec = new Proxy(exec, {
      apply(target, receiver, args) {
        const end = start("sqlite-exec");
        try {
          return Reflect.apply(target, receiver, args);
        } finally {
          end();
        }
      },
    });
    DatabaseSync.prototype.close = new Proxy(close, {
      apply(target, receiver, args) {
        const end = start("sqlite-close");
        try {
          return Reflect.apply(target, receiver, args);
        } finally {
          end();
        }
      },
    });
    syncBuiltinESMExports();
    const { createStoppedSqliteSnapshot }: typeof import("../../src/infra/sqlite-snapshot.js") =
      await import(
        pathToFileURL(path.join(options.sourceRoot, "src/infra/sqlite-snapshot.ts")).href
      );
    const digests = new Map<number, string>();
    for (let sample = 0; sample < options.samples; sample++) {
      for (const [index, { sourcePath, identity }] of sources.entries()) {
        const targetPath = path.join(output, `${sample}-${index}.sqlite`);
        events.length = 0;
        const cpu = process.cpuUsage();
        const at = performance.now();
        try {
          const snapshot = await createStoppedSqliteSnapshot({
            sourcePath,
            targetPath,
            sourceIdentity: identity,
          });
          const wallMs = performance.now() - at;
          const usage = process.cpuUsage(cpu);
          assert.equal(snapshot.sizeBytes, Number(identity.size));
          assert.equal(
            snapshot.sha256,
            digests.get(index) ?? snapshot.sha256,
            "Same-input snapshot digest changed",
          );
          digests.set(index, snapshot.sha256);
          for (const operation of ["native-copy", "native-sha256"]) {
            const observed = events.filter((event) => event.operation === operation);
            assert.equal(observed.length, 1, `Expected one ${operation}`);
            assert.ok(observed[0]);
            assert.equal(observed[0].bytes, snapshot.sizeBytes);
          }
          let previousEnd = at;
          for (const event of events.toSorted((a, b) => a.startedAt - b.startedAt)) {
            assert.ok(
              event.startedAt >= previousEnd,
              "Nested observer intervals would double-count work",
            );
            previousEnd = event.startedAt + event.durationMs;
          }
          const after = fs.statSync(sourcePath, { bigint: true });
          for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode"] as const) {
            assert.equal(after[field], identity[field], `Source ${field} changed`);
          }
          const components = Object.fromEntries(
            [
              "native-copy",
              "native-sha256",
              "fsync-callback",
              "fsync-sync",
              "filehandle-sync",
              "sqlite-exec",
              "sqlite-close",
            ].map((operation) => {
              const observed = events.filter((event) => event.operation === operation);
              return [
                operation,
                {
                  count: observed.length,
                  durationMs: observed.reduce((total, event) => total + event.durationMs, 0),
                  userCPUUs: observed.reduce((total, event) => total + event.userCPUUs, 0),
                  systemCPUUs: observed.reduce((total, event) => total + event.systemCPUUs, 0),
                },
              ];
            }),
          );
          const result = {
            label: options.label,
            sample,
            source: path.relative(fixture, sourcePath),
            bytes: snapshot.sizeBytes,
            copyMethod: events.find((event) => event.operation === "native-copy")?.method,
            wallMs,
            userCPUUs: usage.user,
            systemCPUUs: usage.system,
            components,
            residualMs: wallMs - events.reduce((total, event) => total + event.durationMs, 0),
            residualUserCPUUs:
              usage.user - events.reduce((total, event) => total + event.userCPUUs, 0),
            residualSystemCPUUs:
              usage.system - events.reduce((total, event) => total + event.systemCPUUs, 0),
            nativeStatus,
            node: process.version,
            filesystemType: fs.statfsSync(output).type.toString(16),
            checkpoint:
              "No source checkpoint: stopped input has no journal and an absent or empty WAL",
            scope:
              "Sequential owner call; CPU is process-wide. Residual includes admission, metadata, publication and observer overhead. Copy bytes are logical size, not physical I/O; native-copy reports clone versus transfer. Independent source hashing before both controls warms source reads and stays outside owner timing.",
          };
          fs.writeFileSync(
            path.join(output, `${sample}-${index}.json`),
            JSON.stringify(result, null, 2),
            { flag: "wx", mode: 0o600 },
          );
          console.log(JSON.stringify(result));
        } finally {
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            fs.rmSync(targetPath + suffix, { force: true });
          }
        }
      }
    }
  } finally {
    native.copyFileExclusive = copy;
    native.sha256File = hash;
    fs.fsync = fsync;
    fs.fsyncSync = fsyncSync;
    fs.promises.open = open;
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.close = close;
    syncBuiltinESMExports();
  }
  const oracleAfterCPU = process.cpuUsage();
  const oracleAfterAt = performance.now();
  const sourceProof = sources.map((source) => {
    const digest = options.hashSource(source.sourcePath);
    assert.equal(digest, source.digest, "Source content changed during controls");
    const identity = fs.statSync(source.sourcePath, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode"] as const) {
      assert.equal(identity[field], source.identity[field], `Source ${field} changed`);
    }
    return {
      source: path.relative(fixture, source.sourcePath),
      dev: String(identity.dev),
      ino: String(identity.ino),
      sha256: digest,
      unchanged: true,
    };
  });
  const oracleAfter = {
    wallMs: performance.now() - oracleAfterAt,
    cpuUs: process.cpuUsage(oracleAfterCPU),
  };
  const proof = { sourceProof, untimedOracleBefore: oracleBefore, untimedOracleAfter: oracleAfter };
  fs.writeFileSync(path.join(output, "source-proof.json"), JSON.stringify(proof, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...proof, output }));
}
