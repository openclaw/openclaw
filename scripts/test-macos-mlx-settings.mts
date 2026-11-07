import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import {
  mlxSettingsManifestPath,
  projectMlxSettingsManifest,
  verifyMlxSettingsPackageProjection,
} from "./lib/macos-mlx-settings-manifest.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { NativeCiBudget } from "./lib/native-ci-budget.mts";

const stableSHA = "8b18b5578f66eab1501cba4cef2310d88bfb9a41"; // Named v2026.10.9 baseline.
const overlays = [
  "test/helpers/macos-mlx-settings-producer.ts",
  "apps/macos/Tests/OpenClawIPCTests/MLXSettingsUpgradeTests.swift",
];
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

await runWithFailedTrailer("macos-mlx-settings", async () => {
  const env = process.env;
  assert(
    env.GITHUB_ACTIONS === "true" &&
      env.CI === "true" &&
      env.GITHUB_REPOSITORY === "openclaw/openclaw" &&
      process.platform === "darwin",
  );
  assert.equal(process.version, "v24.22.1");
  const [proofPath, started, selectedSHA] = process.argv.slice(2);
  assert(proofPath && started && selectedSHA && /^[a-f0-9]{40}$/.test(selectedSHA));
  const budget = new NativeCiBudget(started);
  const current = fs.realpathSync(process.cwd());
  const runnerTemp = fs.realpathSync(env.RUNNER_TEMP!);
  const proofDir = fs.realpathSync(proofPath);
  assert(proofDir.startsWith(runnerTemp + path.sep) && !fs.lstatSync(proofPath).isSymbolicLink());
  const scratch = fs.mkdtempSync(path.join(runnerTemp, "openclaw-mlx-settings-"));
  const stable = path.join(scratch, "stable");
  const capturePath = path.join(scratch, "command-output");
  let canRemove = true;
  let phase = "source setup";
  let phaseEnd = performance.now() + 6 * 60_000;
  const manifestProjections = new Map<
    string,
    { original: Buffer; originalBlob: string; effectiveBlob: string; effectiveSHA256: string }
  >();
  const result: Record<string, unknown> = {
    version: 1,
    complete: false,
    stableRelease: "v2026.10.9",
    phases: [],
  };
  const childEnv = {
    ...env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const run = async (
    bin: string,
    args: string[],
    cwd: string,
    ceiling = 60_000,
    capture = false,
  ) => {
    const timeoutMs = Math.min(budget.timeout(ceiling), Math.floor(phaseEnd - performance.now()));
    assert(timeoutMs > 0, `${phase}: phase budget exhausted`);
    const fd = capture ? fs.openSync(capturePath, "w", 0o600) : undefined;
    canRemove = false;
    try {
      const code = await runManagedCommand({
        bin,
        args,
        cwd,
        env: childEnv,
        stdio: fd === undefined ? "inherit" : ["ignore", fd, "inherit"],
        requireProcessTreeExit: true,
        timeoutMs,
        timeoutKillGraceMs: 5_000,
        signalKillGraceMs: 5_000,
        abortKillGraceMs: 5_000,
        cleanupDrainTimeoutMs: 5_000,
      });
      canRemove = true;
      assert.equal(code, 0, `${phase}: ${bin} failed (exit ${code})`);
      if (fd === undefined) {
        return "";
      }
      assert(
        fs.statSync(capturePath).size <= 32 * 1024 * 1024,
        "Source metadata exceeds capture bound",
      );
      return fs.readFileSync(capturePath, "utf8").trim();
    } catch (error) {
      canRemove = !hasUnjoinedWork(error);
      throw error;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  };
  type Entry = { relative: string; mode: string; blob: string };
  const entries = async (revision: string): Promise<Entry[]> => {
    const text = await run("git", ["ls-tree", "-r", "-z", revision], current, 30_000, true);
    return text
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const tab = row.indexOf("\t");
        const [mode, kind, blob] = row.slice(0, tab).split(" ");
        const relative = row.slice(tab + 1);
        assert(kind === "blob" && ["100644", "100755", "120000"].includes(mode!));
        assert(
          !path.isAbsolute(relative) &&
            !relative.split("/").some((x) => ["..", ".git"].includes(x)),
        );
        return { relative, mode: mode!, blob: blob! };
      });
  };
  const verify = (source: string, tree: Entry[]) => {
    for (const entry of tree) {
      budget.timeout(1);
      const file = path.join(source, entry.relative);
      const stat = fs.lstatSync(file);
      const data =
        entry.mode === "120000" ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
      assert(
        entry.mode === "120000" ? stat.isSymbolicLink() : stat.isFile(),
        "Source entry kind changed",
      );
      if (entry.mode !== "120000") {
        assert.equal(
          (stat.mode & 0o111) !== 0,
          entry.mode === "100755",
          "Source executable mode changed",
        );
      }
      assert(
        fs.realpathSync(file).startsWith(source + path.sep),
        "Source link escapes its own revision",
      );
      const projection =
        entry.relative === mlxSettingsManifestPath ? manifestProjections.get(source) : undefined;
      if (projection) {
        assert.equal(entry.blob, projection.originalBlob, "Original manifest identity changed");
      }
      assert.equal(
        createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"),
        projection?.effectiveBlob ?? entry.blob,
        `Production input changed: ${entry.relative}`,
      );
    }
  };
  let failure: Error | undefined;
  try {
    assert.equal(await run("git", ["rev-parse", "HEAD"], current, 30_000, true), selectedSHA);
    const currentTree = await entries(selectedSHA);
    verify(current, currentTree);
    await run(
      "git",
      [
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "fetch",
        "--depth=1",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--refmap=",
        "https://github.com/openclaw/openclaw.git",
        stableSHA,
      ],
      current,
      120_000,
    );
    const stableTree = await entries(stableSHA);
    const archive = path.join(scratch, "stable.tar");
    await run("git", ["archive", "--format=tar", "--output", archive, stableSHA], current);
    // The complete App/root dependency graph needs a full source export. Reject
    // escaping links and non-source entries; never copy a candidate build graph.
    await run(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        [
          "import pathlib,tarfile,sys",
          "root=pathlib.Path(sys.argv[2]); root.mkdir()",
          "with tarfile.open(sys.argv[1]) as archive:",
          " entries=archive.getmembers()",
          " assert len(entries)<=200000 and sum(x.size for x in entries)<=2*1024**3, 'Source export exceeds bound'",
          " for entry in entries:",
          "  target=root/entry.name; assert target.resolve().is_relative_to(root.resolve()) and '.git' not in target.parts",
          "  assert entry.isdir() or entry.isfile() or entry.issym(), 'Unsupported source entry'",
          "  if entry.issym(): assert not pathlib.Path(entry.linkname).is_absolute() and (target.parent/entry.linkname).resolve().is_relative_to(root.resolve())",
          "  archive.extract(entry,root)",
        ].join("\n"),
        archive,
        stable,
      ],
      current,
    );
    fs.unlinkSync(archive);
    verify(stable, stableTree);
    const overlayHashes = Object.fromEntries(
      overlays.map((relative) => [relative, sha256(path.join(current, relative))]),
    );
    const verifyOverlays = (source: string) => {
      for (const relative of overlays) {
        assert.equal(
          sha256(path.join(source, relative)),
          overlayHashes[relative],
          "Test overlay changed",
        );
      }
    };
    for (const relative of overlays) {
      const target = path.join(stable, relative);
      assert(!fs.existsSync(target), "Stable test-overlay path already exists");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(current, relative), target);
      assert.equal(sha256(target), overlayHashes[relative]);
    }
    const identities = {
      stable: { sourceRoot: stable, sha: stableSHA },
      fixed: { sourceRoot: current, sha: selectedSHA },
      overlays: overlayHashes,
    };
    const dependencyInputs = (source: string, tree: Entry[]) =>
      Object.fromEntries(
        tree
          .filter((x) =>
            /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Package\.(swift|resolved))$|^patches\//.test(
              x.relative,
            ),
          )
          .map((x) => [x.relative, sha256(path.join(source, x.relative))]),
      );
    result.sources = {
      stable: { sha: stableSHA, inputs: dependencyInputs(stable, stableTree) },
      fixed: { sha: selectedSHA, inputs: dependencyInputs(current, currentTree) },
      overlays: overlayHashes,
    };
    // Source-path imports reach beyond root-manifest dependency edges. Each
    // revision needs its own full frozen workspace install, sharing only CAS.
    const pm = JSON.parse(
      fs.readFileSync(path.join(stable, "package.json"), "utf8"),
    ).packageManager;
    assert.equal(
      pm,
      JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")).packageManager,
    );
    assert(pm.startsWith("pnpm@12.15.0+sha512."));
    assert.equal(await run("pnpm", ["--version"], stable, 30_000, true), "12.15.0");
    await run(
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--prefer-offline",
        "--optional",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
      ],
      stable,
      240_000,
    );
    await run(process.execPath, ["scripts/prepare-apple-mermaid.mjs"], stable, 120_000);
    verify(stable, stableTree);
    verify(current, currentTree);
    verifyOverlays(stable);
    verifyOverlays(current);
    const testBuildManifests: Record<string, object> = {};
    result.testBuildManifests = testBuildManifests;
    for (const [name, source, tree] of [
      ["stable", stable, stableTree],
      ["fixed", current, currentTree],
    ] as const) {
      const file = path.join(source, mlxSettingsManifestPath);
      const original = fs.readFileSync(file);
      const entry = tree.find((item) => item.relative === mlxSettingsManifestPath);
      assert(entry?.mode === "100644", "Settings manifest must be a tracked regular source file");
      const originalDump = await run(
        "swift",
        ["package", "--package-path", "apps/macos", "dump-package"],
        source,
        30_000,
        true,
      );
      const effective = Buffer.from(projectMlxSettingsManifest(original.toString("utf8")));
      const effectiveSHA256 = createHash("sha256").update(effective).digest("hex");
      manifestProjections.set(source, {
        original,
        originalBlob: entry.blob,
        effectiveBlob: createHash("sha1")
          .update(`blob ${effective.length}\0`)
          .update(effective)
          .digest("hex"),
        effectiveSHA256,
      });
      const receipt = {
        originalBlob: entry.blob,
        originalSHA256: createHash("sha256").update(original).digest("hex"),
        effectiveSHA256,
        originalDumpSHA256: createHash("sha256").update(originalDump).digest("hex"),
        effectiveDumpSHA256: "",
        semanticVerified: false,
      };
      testBuildManifests[name] = receipt;
      fs.writeFileSync(file, effective);
      const effectiveDump = await run(
        "swift",
        ["package", "--package-path", "apps/macos", "dump-package"],
        source,
        30_000,
        true,
      );
      verifyMlxSettingsPackageProjection(JSON.parse(originalDump), JSON.parse(effectiveDump));
      receipt.effectiveDumpSHA256 = createHash("sha256").update(effectiveDump).digest("hex");
      receipt.semanticVerified = true;
      verify(source, tree);
    }
    Object.assign(identities, { testBuildManifests });
    const builtProducts: Record<string, object[]> = {};
    for (const [name, source, tree] of [
      ["stable", stable, stableTree],
      ["fixed", current, currentTree],
    ] as const) {
      phase = `${name}: actual App test build`;
      phaseEnd = performance.now() + 9 * 60_000;
      console.log(`[mlx-settings] ${phase}`);
      const began = performance.now();
      await run(
        "swift",
        [
          "build",
          "--package-path",
          "apps/macos",
          "--build-system",
          "native",
          "--enable-code-coverage",
          "--disable-index-store",
          "-Xswiftc",
          "-gline-tables-only",
          "--build-tests",
        ],
        source,
        9 * 60_000,
      );
      verify(source, tree);
      verifyOverlays(source);
      const bin = fs.realpathSync(
        await run(
          "swift",
          [
            "build",
            "--package-path",
            "apps/macos",
            "--build-system",
            "native",
            "--enable-code-coverage",
            "--disable-index-store",
            "-Xswiftc",
            "-gline-tables-only",
            "--show-bin-path",
          ],
          source,
          30_000,
          true,
        ),
      );
      assert(
        bin.startsWith(path.join(source, "apps/macos/.build") + path.sep),
        "App products escape their own build graph",
      );
      builtProducts[name] = [];
      for (const bundle of fs.readdirSync(bin).filter((x) => x.endsWith(".xctest"))) {
        const macos = path.join(bin, bundle, "Contents/MacOS");
        for (const entry of fs.readdirSync(macos)) {
          const binary = path.join(macos, entry);
          const stat = fs.lstatSync(binary);
          if (!stat.isFile() || !(stat.mode & 0o111)) {
            continue;
          }
          assert(
            fs.realpathSync(binary).startsWith(bin + path.sep),
            "Test product escapes its own revision",
          );
          const hash = createHash("sha256");
          for await (const chunk of fs.createReadStream(binary)) {
            budget.timeout(1);
            hash.update(chunk);
          }
          builtProducts[name].push({
            path: path.relative(source, binary),
            bytes: stat.size,
            sha256: hash.digest("hex"),
          });
        }
      }
      assert(
        builtProducts[name].length > 0 && builtProducts[name].length <= 10,
        "Actual App test products missing or unexpected",
      );
      (result.phases as unknown[]).push({
        name: phase,
        seconds: (performance.now() - began) / 1000,
      });
    }
    result.testProducts = builtProducts;
    const manifest = path.join(scratch, "prepared-sources.json");
    fs.writeFileSync(manifest, JSON.stringify(identities), { mode: 0o600 });
    phase = "ordered settings consumers";
    phaseEnd = budget.cleanupEnd;
    // The nested owner re-samples the ORIGINAL Python job start, retaining its
    // cleanup allowance even when this owner's work budget is nearly exhausted.
    canRemove = false;
    const code = await runManagedCommand({
      bin: process.execPath,
      args: ["scripts/test-macos-native.mts", "settings-upgrade", manifest, started, proofDir],
      cwd: current,
      env: childEnv,
      stdio: "inherit",
      requireProcessTreeExit: true,
      timeoutMs: budget.timeout(6 * 60_000, true),
      timeoutKillGraceMs: 5_000,
      signalKillGraceMs: 5_000,
      abortKillGraceMs: 5_000,
      cleanupDrainTimeoutMs: 5_000,
    });
    const consumerReceipt = path.join(proofDir, "settings-consumers.json");
    canRemove =
      fs.existsSync(consumerReceipt) &&
      JSON.parse(fs.readFileSync(consumerReceipt, "utf8")).resourcesRemoved === true;
    assert.equal(code, 0, `Ordered settings proof failed (exit ${code})`);
    assert(
      canRemove && JSON.parse(fs.readFileSync(consumerReceipt, "utf8")).complete === true,
      "Native settings resource retirement is unverified",
    );
    verify(stable, stableTree);
    verify(current, currentTree);
    verifyOverlays(stable);
    verifyOverlays(current);
    result.complete = true;
  } catch (error) {
    result.failure = { phase, detail: String(error) };
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    result.sourceProcessesRetired = canRemove;
    result.scratchRemoved = false;
    result.testBuildManifestsRestored = false;
    if (canRemove) {
      try {
        for (const [source, projection] of manifestProjections) {
          const file = path.join(source, mlxSettingsManifestPath);
          assert.equal(
            sha256(file),
            projection.effectiveSHA256,
            "Settings manifest changed before retirement",
          );
          fs.writeFileSync(file, projection.original);
          assert.equal(
            sha256(file),
            createHash("sha256").update(projection.original).digest("hex"),
            "Original settings manifest was not restored",
          );
        }
        result.testBuildManifestsRestored = true;
        fs.rmSync(scratch, { recursive: true, force: true });
        result.scratchRemoved = true;
      } catch (error) {
        const retirementError = error instanceof Error ? error : new Error(String(error));
        failure = failure
          ? new AggregateError([failure, retirementError], "Settings proof and retirement failed")
          : retirementError;
        result.complete = false;
        result.retirementFailure = String(error);
      }
    }
    const payload = JSON.stringify(result, null, 2)
      .replaceAll(scratch, "<owned-scratch>")
      .replaceAll(current, "<current-source>");
    assert(Buffer.byteLength(payload) < 128 * 1024, "Settings metadata exceeds artifact bound");
    fs.writeFileSync(path.join(proofDir, "settings-sources.json"), payload + "\n");
    if (!result.scratchRemoved) {
      console.error(`[mlx-settings] retained resources after incomplete retirement: ${scratch}`);
    }
  }
  if (failure) {
    throw failure;
  }
});
