import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listDirectoryTreeStrictSync } from "../src/infra/directory-walk.js";
import { resolveUpdateCandidatePluginPath } from "../src/infra/update-candidate-paths.js";
import { sealUpdateCandidatePluginAssets } from "../src/infra/update-candidate-plugin-assets.js";
import {
  captureUpdateCandidatePluginCodeLink,
  sealUpdateCandidatePluginCodeLinks,
  type UpdateCandidatePluginCodeLink,
} from "../src/infra/update-candidate-plugin-code-links.js";
import {
  prepareUpdateCandidatePluginTrees,
  copyUpdateCandidatePluginTrees,
} from "../src/infra/update-candidate-plugin-tree.js";
import { closeDefaultRetainedNativeWorkerSource } from "../src/infra/worker-native-lifecycle.js";
import { preparePluginGenerationArtifact } from "../src/plugins/plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "../src/plugins/plugin-source-capture-context.js";
import {
  claimProofOutput,
  parseProofArgs,
  probeProofCapabilities,
  proofOwnershipSkipReason,
  unsupportedProofReason,
} from "./proof-output.mts";
const cases = [
  "unverified",
  "code-link-only",
  "mutated-link",
  "mutated-target",
  "mutated-content",
  "outside",
  "directory",
  "other-state",
  "hardlink",
  "parent-symlink",
  "receipt-tamper",
  "receipt-other-state",
  "recovery",
  "native-alias",
  "external-native-file",
] as const;
const args = parseProofArgs(process.argv.slice(2), cases);
const ownershipSkip = proofOwnershipSkipReason();
if (ownershipSkip) {
  console.log(JSON.stringify({ pass: false, skipped: true, reason: ownershipSkip }));
  process.exit(0);
}
const out = claimProofOutput(args.out, "private-asset-negative");
const capabilities = probeProofCapabilities(out);
const results: Array<{ kind: string; skipped?: boolean; [key: string]: unknown }> = [];
try {
  for (const kind of cases.filter(
    (caseName) => !args.selectedCase || caseName === args.selectedCase,
  )) {
    const skipReason = unsupportedProofReason(capabilities, kind === "hardlink");
    if (skipReason) {
      results.push({ kind, skipped: true, skipReason });
      fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
      continue;
    }
    const work = path.join(out, kind),
      source = path.join(work, "source/plugin"),
      external = path.join(
        work,
        kind === "external-native-file" ? "source/assets/config.so" : "source/assets/config.txt",
      ),
      state = path.join(work, "state"),
      plugin = resolveUpdateCandidatePluginPath(work, state, source),
      candidate = path.join(work, "candidate");
    for (const directory of [source, path.dirname(external), state, candidate]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.chmodSync(state, 0o700);
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ name: "edge-test", type: "module" }),
    );
    fs.writeFileSync(path.join(source, "index.mjs"), "export default 42;");
    fs.writeFileSync(external, "owned bytes");
    if (kind === "native-alias") {
      fs.writeFileSync(path.join(source, "addon.so"), Buffer.alloc(128, "A"));
      fs.symlinkSync("addon.so", path.join(source, "addon-alias.so"));
    }
    fs.symlinkSync(external, path.join(source, "config.txt"));
    const plan = await prepareUpdateCandidatePluginTrees({
      roots: new Map([[source, plugin]]),
      project: (f) => resolveUpdateCandidatePluginPath(work, state, f),
      targetStateDir: state,
      candidateRoot: candidate,
    });
    const edges: UpdateCandidatePluginCodeLink[] = [];
    await copyUpdateCandidatePluginTrees(plan, {
      targetStateDir: state,
      candidateRoot: candidate,
      onCodeLink: (e) => edges.push(e),
    });
    const link = path.join(plugin, "config.txt"),
      target = fs.realpathSync(link),
      edge = edges.find((e) => e.path === link)!;
    let receipt = await sealUpdateCandidatePluginAssets(state, edges);
    if (kind === "external-native-file") {
      fs.writeFileSync(
        path.join(path.dirname(target), "unrelated-native-sibling.so"),
        "not authorized by the exact edge",
      );
    }
    if (kind === "unverified") {
      receipt = "";
    }
    if (kind === "code-link-only") {
      receipt = await sealUpdateCandidatePluginAssets(
        state,
        edges.map(({ asset: _asset, ...e }) => e),
      );
    }
    if (kind === "mutated-link") {
      const text = fs.readlinkSync(link);
      fs.renameSync(link, link + ".old");
      fs.symlinkSync(text, link);
    }
    if (kind === "mutated-target") {
      fs.renameSync(target, target + ".old");
      fs.writeFileSync(target, "owned bytes");
    }
    if (kind === "mutated-content") {
      fs.writeFileSync(target, "other bytes");
    }
    if (kind === "hardlink") {
      fs.linkSync(target, target + ".alias");
    }
    if (kind === "parent-symlink") {
      const parent = path.dirname(target);
      fs.renameSync(parent, parent + ".old");
      fs.symlinkSync(parent + ".old", parent);
    }
    if (["outside", "directory", "other-state"].includes(kind)) {
      const alternate =
        kind === "outside"
          ? external
          : kind === "directory"
            ? path.join(path.dirname(target), "directory")
            : path.join(state, "secrets/config.txt");
      if (kind === "directory") {
        fs.mkdirSync(alternate);
      } else if (kind === "other-state") {
        fs.mkdirSync(path.dirname(alternate));
        fs.writeFileSync(alternate, "owned bytes");
      }
      fs.unlinkSync(link);
      fs.symlinkSync(alternate, link);
      const forged = {
        ...captureUpdateCandidatePluginCodeLink(
          link,
          fs.lstatSync(link, { bigint: true }),
          fs.readlinkSync(link),
        ),
        asset: edge.asset,
      };
      const sealed = await sealUpdateCandidatePluginCodeLinks(
        path.join(state, ".update-plugin-assets.json"),
        [forged],
      );
      receipt = JSON.stringify({ stateDir: state, ...sealed });
    }
    if (kind === "receipt-tamper") {
      fs.appendFileSync(path.join(state, ".update-plugin-assets.json"), " ");
    }
    if (kind === "receipt-other-state") {
      receipt = JSON.stringify({ ...JSON.parse(receipt), stateDir: work });
    }
    let failed: string | undefined,
      omitted = false,
      recovered = false;
    await withPluginSourceCaptureStorage(
      { stateDir: state, placement: "state", privateAssetReceipt: receipt },
      async () => {
        let artifact:
          | Awaited<ReturnType<typeof preparePluginGenerationArtifact>>["artifact"]
          | undefined;
        try {
          artifact = (
            await preparePluginGenerationArtifact({
              rootDir: plugin,
              source: path.join(plugin, "index.mjs"),
            })
          ).artifact;
          omitted = !fs.existsSync(path.join(artifact.rootDir, "config.txt"));
          if (kind === "external-native-file") {
            assert.equal(
              fs.readFileSync(path.join(artifact.rootDir, "config.txt"), "utf8"),
              "owned bytes",
            );
            const siblingCopies = listDirectoryTreeStrictSync(state).filter(
              (file) => file.dirent.name === "unrelated-native-sibling.so",
            );
            assert.equal(
              siblingCopies.length,
              1,
              "exact file edge must not snapshot its native parent",
            );
            recovered = true;
          }
          if (kind === "native-alias") {
            assert.equal(
              fs.readFileSync(path.join(artifact.rootDir, "addon-alias.so")).length,
              128,
            );
            recovered = true;
          }
          if (kind === "recovery") {
            const custody = artifact.retainSourceCustody();
            const recovery = artifact.captureRecoverySource();
            const fork = recovery.fork();
            await artifact.disposeAsync();
            artifact = undefined;
            fs.renameSync(
              path.join(state, "candidate-plugins"),
              path.join(state, "retired-plugins"),
            );
            for (const owner of [custody.source, recovery, fork]) {
              assert.equal(fs.readFileSync(owner.resolve(link), "utf8"), "owned bytes");
            }
            await custody.source.disposeAsync();
            await recovery.disposeAsync();
            await fork.disposeAsync();
            recovered = true;
          }
        } catch (error) {
          failed = String(error);
        } finally {
          await artifact?.disposeAsync();
        }
      },
    );
    if (["unverified", "code-link-only"].includes(kind)) {
      assert(omitted && !failed, kind + ": " + failed);
    } else if (["recovery", "native-alias", "external-native-file"].includes(kind)) {
      assert(recovered && !failed, failed);
    } else {
      assert(failed, kind + " unexpectedly admitted");
      const expectedReasons: Record<string, RegExp> = {
        "mutated-link": /^Error: Copied plugin code link changed:/u,
        "mutated-target": /^Error: Copied plugin code link changed:/u,
        "mutated-content": /^Error: Private plugin asset content changed$/u,
        outside: /^Error: Private plugin asset is not a projected plugin file$/u,
        directory: /^Error: Cannot open verified private plugin asset$/u,
        "other-state": /^Error: Private plugin asset is not a projected plugin file$/u,
        hardlink: /^Error: Cannot open verified private plugin asset$/u,
        "parent-symlink": /^Error: Private plugin asset has an unsafe parent$/u,
        "receipt-tamper": /^RangeError: File exceeds [0-9]+ bytes$/u,
        "receipt-other-state":
          /^Error: Private plugin asset receipt has the wrong state root or size$/u,
      };
      assert.match(failed, expectedReasons[kind], kind + ": unexpected rejection reason");
    }
    assert.equal(fs.readFileSync(external, "utf8"), "owned bytes");
    results.push({
      kind,
      denied: Boolean(failed) || omitted,
      error: failed,
      recovered,
      originalUnchanged: true,
    });
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  }
  console.log(
    JSON.stringify({ pass: results.every((row) => !row.skipped), capabilities, results }, null, 2),
  );
} finally {
  await closeDefaultRetainedNativeWorkerSource();
}
