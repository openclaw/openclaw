import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveUpdateCandidatePluginPath } from "../src/infra/update-candidate-paths.js";
import {
  sealUpdateCandidatePluginAssets,
  UPDATE_PLUGIN_ASSET_RECEIPT_ENV,
} from "../src/infra/update-candidate-plugin-assets.js";
import type { UpdateCandidatePluginCodeLink } from "../src/infra/update-candidate-plugin-code-links.js";
import {
  prepareUpdateCandidatePluginTrees,
  copyUpdateCandidatePluginTrees,
} from "../src/infra/update-candidate-plugin-tree.js";
import { closeDefaultRetainedNativeWorkerSource } from "../src/infra/worker-native-lifecycle.js";
import { createJiti } from "../src/plugins/jiti-factory.js";
import { preparePluginGenerationArtifact } from "../src/plugins/plugin-generation-worker.js";
import { bindPluginInstanceModuleLoader } from "../src/plugins/plugin-instance-module-loader.js";
import { PluginInstance } from "../src/plugins/plugin-instance.js";
import { withPluginSourceCaptureStorage } from "../src/plugins/plugin-source-capture-context.js";
import { visitPluginSourceReferences } from "../src/plugins/plugin-source-references.js";
import {
  claimProofOutput,
  parseProofArgs,
  probeProofCapabilities,
  proofOwnershipSkipReason,
  unsupportedProofReason,
} from "./proof-output.mts";
import { pluginSource, pluginManifestFixture } from "./release-closeout-upgrade-proof.mjs";
const args = parseProofArgs(process.argv.slice(2));
const ownershipSkip = proofOwnershipSkipReason();
if (ownershipSkip) {
  console.log(JSON.stringify({ pass: false, skipped: true, reason: ownershipSkip }));
  process.exit(0);
}
const out = claimProofOutput(args.out, "prepared-asset-boundary");
const capabilities = probeProofCapabilities(out);
const payload = "release-closeout-external-asset\n";
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function describeError(error: unknown) {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: "code" in error ? String(error.code) : undefined,
      }
    : { name: "NonError", message: String(error), stack: undefined, code: undefined };
}
function observe(file: string) {
  try {
    const stat = fs.lstatSync(file);
    return {
      path: file,
      kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other",
      link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null,
      real: fs.realpathSync(file),
      sha256: hash(file),
      ino: fs.statSync(file).ino,
    };
  } catch (error) {
    const detail = describeError(error);
    return { path: file, error: detail.code, message: detail.message };
  }
}
function scan(root: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    files.push(f);
    if (e.isDirectory()) {
      files.push(...scan(f));
    }
  }
  return files;
}
type Observation = ReturnType<typeof observe>;
type ProofRow = {
  kind: string;
  references: Array<{ reference: string; kind: string }>;
  sourceBefore: Observation;
  originalLinkBefore: Observation;
  privateSourceBefore?: Observation;
  projectedBefore?: Observation;
  projectedAfter?: Observation;
  preparedConfig?: Observation;
  phase?: string;
  ledger?: string | null;
  failure?: ReturnType<typeof describeError> & { phase?: string };
  [key: string]: unknown;
};
const results: ProofRow[] = [];
try {
  for (const kind of [
    "original-indirectpath-external-symlink",
    "literal-newURL-external-symlink",
    "internal-regular-file",
  ]) {
    const skipReason = unsupportedProofReason(capabilities);
    if (skipReason) {
      results.push({
        kind,
        references: [],
        sourceBefore: { path: "", error: "SKIPPED", message: skipReason },
        originalLinkBefore: { path: "", error: "SKIPPED", message: skipReason },
        skipped: true,
        skipReason,
      });
      fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
      continue;
    }
    const work = path.join(out, kind),
      plugin = path.join(work, "fixture/plugin"),
      assets = path.join(work, "fixture/assets"),
      source = path.join(assets, "config.txt"),
      state = path.join(work, "operator-state"),
      privateState = path.join(work, "openclaw-update-canary-proof"),
      projected = resolveUpdateCandidatePluginPath(state, privateState, plugin),
      candidate = path.join(work, "candidate"),
      ledger = path.join(work, "observations.jsonl");
    for (const dir of [plugin, assets, state, candidate, privateState]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.chmodSync(privateState, 0o700);
    fs.writeFileSync(path.join(work, "fixture/package.json"), "{}\n");
    fs.writeFileSync(source, payload);
    fs.symlinkSync(
      path.join(work, "fixture/missing-unrelated-target"),
      path.join(assets, "unrelated-broken-link"),
    );
    if (kind === "internal-regular-file") {
      fs.writeFileSync(path.join(plugin, "config.txt"), payload);
    } else {
      fs.symlinkSync(source, path.join(plugin, "config.txt"));
    }
    fs.writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "closeout-owner-proof",
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    fs.writeFileSync(
      path.join(plugin, "openclaw.plugin.json"),
      JSON.stringify(pluginManifestFixture()),
    );
    let code = pluginSource({ plugin, source, state, ledger });
    if (kind === "literal-newURL-external-symlink") {
      code = code.replace(
        'const asset=path.join(root,"config.txt"),physical=',
        'const asset=fileURLToPath(new URL("./config.txt",import.meta.url)),physical=',
      );
    }
    if (kind === "internal-regular-file") {
      code = code.replace(
        'assert.equal(fs.readlinkSync(path.join(originalPlugin,"config.txt")),source);',
        'assert(fs.lstatSync(path.join(originalPlugin,"config.txt")).isFile());',
      );
    }
    fs.writeFileSync(path.join(plugin, "index.mjs"), code);
    fs.writeFileSync(
      path.join(plugin, "doctor-contract-api.mjs"),
      'export { normalizeCompatibilityConfig } from "./index.mjs";\n',
    );
    const references: ProofRow["references"] = [];
    visitPluginSourceReferences(
      path.join(plugin, "index.mjs"),
      code,
      () =>
        createJiti(path.join(plugin, "index.mjs"), {
          fsCache: false,
          moduleCache: false,
          tryNative: false,
        }),
      (reference, referenceKind) => references.push({ reference, kind: referenceKind }),
    );
    const row: ProofRow = {
      kind,
      references,
      sourceBefore: observe(source),
      originalLinkBefore: observe(path.join(plugin, "config.txt")),
    };
    results.push(row);
    const save = () =>
      fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
    let artifact:
      | Awaited<ReturnType<typeof preparePluginGenerationArtifact>>["artifact"]
      | undefined;
    let instance: PluginInstance | undefined;
    try {
      const plan = await prepareUpdateCandidatePluginTrees({
        roots: new Map([[plugin, projected]]),
        project: (entry) => resolveUpdateCandidatePluginPath(state, privateState, entry),
        targetStateDir: privateState,
        candidateRoot: candidate,
      });
      fs.writeFileSync(
        path.join(work, "plan.json"),
        JSON.stringify(
          plan,
          (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v),
          2,
        ),
      );
      const edges: UpdateCandidatePluginCodeLink[] = [];
      await copyUpdateCandidatePluginTrees(plan, {
        targetStateDir: privateState,
        candidateRoot: candidate,
        onCodeLink: (edge) => edges.push(edge),
      });
      process.env[UPDATE_PLUGIN_ASSET_RECEIPT_ENV] = await sealUpdateCandidatePluginAssets(
        privateState,
        edges,
      );
      row.projectedBefore = observe(path.join(projected, "config.txt"));
      row.privateSourceBefore = observe(fs.realpathSync(path.join(projected, "config.txt")));
      assert.notEqual(row.privateSourceBefore.ino, row.sourceBefore.ino);
      assert.equal(row.projectedBefore.sha256, row.sourceBefore.sha256);
      assert(!scan(privateState).some((f) => path.basename(f) === "unrelated-broken-link"));
      if (kind !== "internal-regular-file") {
        assert.equal(row.projectedBefore.kind, "symlink");
        assert.notEqual(row.projectedBefore.real, source);
        assert(row.projectedBefore.real?.startsWith(privateState + path.sep));
        assert(!row.projectedBefore.real?.startsWith(projected + path.sep));
      }
      process.env.OPENCLAW_STATE_DIR = privateState;
      process.env.OPENCLAW_CONFIG_PATH = path.join(privateState, "openclaw.json");
      row.phase = "prepare";
      save();
      await withPluginSourceCaptureStorage(
        { stateDir: privateState, placement: "state" },
        async () => {
          const prepared = await preparePluginGenerationArtifact({
            rootDir: projected,
            source: path.join(projected, "index.mjs"),
          });
          artifact = prepared.artifact;
          row.artifact = {
            sourceRoot: artifact.sourceRoot,
            rootDir: artifact.rootDir,
            boundaryRoot: artifact.boundaryRoot,
            sourceDigest: artifact.sourceDigest,
          };
          row.sourceRootConfig = observe(path.join(artifact.sourceRoot, "config.txt"));
          row.privateSourceAfterPreparation = observe(row.privateSourceBefore!.path);
          row.preparedConfig = observe(path.join(artifact.rootDir, "config.txt"));
          row.phase = "bind";
          save();
          instance = new PluginInstance("closeout-owner-proof");
          bindPluginInstanceModuleLoader({
            instance,
            origin: "config",
            source: path.join(projected, "index.mjs"),
            rootDir: projected,
            preparedArtifact: prepared,
          });
          row.phase = "load";
          save();
          const loaded = (await instance.loadModule(path.join(projected, "index.mjs"))) as {
            default: { register(): Promise<void> };
          };
          row.phase = "register";
          save();
          await loaded.default.register();
          row.phase = "complete";
        },
      );
    } catch (error) {
      row.failure = { phase: row.phase, ...describeError(error) };
    } finally {
      row.sourceAfter = observe(source);
      row.originalLinkAfter = observe(path.join(plugin, "config.txt"));
      row.projectedAfter = observe(path.join(projected, "config.txt"));
      row.privateSourceAfter = observe(row.privateSourceBefore!.path);
      assert.deepEqual(row.privateSourceAfter, row.privateSourceBefore);
      if (artifact) {
        row.preparedConfigAfter = observe(path.join(artifact.rootDir, "config.txt"));
      }
      row.privateFilesBeforeDisposal = scan(privateState);
      row.ledger = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null;
      row.diagnostics = fs.existsSync(ledger + ".diagnostics.jsonl")
        ? fs.readFileSync(ledger + ".diagnostics.jsonl", "utf8")
        : null;
      assert.deepEqual(row.sourceAfter, row.sourceBefore, "original source mutated");
      assert.deepEqual(row.originalLinkAfter, row.originalLinkBefore, "original link/file mutated");
      assert.equal(
        row.projectedAfter.sha256,
        row.sourceBefore.sha256,
        "projected asset not restored",
      );
      assert(!scan(privateState).some((f: string) => path.basename(f) === "unrelated-broken-link"));
      if (instance) {
        row.disposal = await instance.dispose();
      }
      if (artifact) {
        await artifact.disposeAsync();
      }
      save();
    }
  }
  for (const row of results) {
    if (row.skipped) {
      continue;
    }
    assert.equal(row.phase, "complete", JSON.stringify(row.failure));
    assert(row.preparedConfig);
    assert.equal(row.preparedConfig.kind, "file");
    assert.equal(row.preparedConfig.sha256, row.sourceBefore.sha256);
    assert(row.ledger);
    const ledger = JSON.parse(row.ledger.trim());
    assert.equal(ledger.privateWriteProven, true);
    assert.equal(ledger.sourceUnchanged, true);
    assert.equal(ledger.unrelatedAbsent, true);
  }
  console.log(
    JSON.stringify(
      {
        pass: results.every((row) => !row.skipped),
        capabilities,
        cases: results.map((r) => ({
          kind: r.kind,
          skipped: r.skipped,
          skipReason: r.skipReason,
          phase: r.phase,
          failure: r.failure?.message,
          prepared: r.preparedConfig,
          ledger: r.ledger,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await closeDefaultRetainedNativeWorkerSource();
}
