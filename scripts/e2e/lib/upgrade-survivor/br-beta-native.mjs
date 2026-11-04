#!/usr/bin/env node
// Task-only exact-beta adapter of the maintained native fixture. Do not land.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, manifestTree } from "./br-beta-native-evidence.mjs";

const emitOnly = process.argv[2] === "--emit-source";
const [candidate, artifactArg, baseline] = emitOnly ? [undefined, undefined, "2026.11.5-beta.1"] : process.argv.slice(2);
assert.equal(baseline, "2026.11.5-beta.1", "BR proof admits only the exact observed published beta");
if (!emitOnly) assert(candidate && artifactArg);
const artifacts = emitOnly ? undefined : path.resolve(artifactArg);
if (!emitOnly) fs.mkdirSync(artifacts, { recursive: true });
const harness = path.dirname(fileURLToPath(import.meta.url));
const owner = path.join(harness, "native-systemd.mjs");
let source = fs.readFileSync(owner, "utf8");
function replace(before, after) {
  assert.equal(source.split(before).length, 2, `Canonical native fixture changed: ${before.slice(0, 80)}`);
  source = source.replace(before, after);
}
replace('"./native-systemd-contract.mjs"', JSON.stringify(pathToFileURL(path.join(harness, "native-systemd-contract.mjs")).href));
replace('const [candidateArg, artifactsArg, ...baselines] = process.argv.slice(2);',
  `import { captureBefore, collectAfter, captureVolatile } from ${JSON.stringify(pathToFileURL(path.join(harness, "br-beta-native-evidence.mjs")).href)};\nconst [candidateArg, artifactsArg, ...baselines] = process.argv.slice(2);`);
replace('const plan = planNativeUpgradeSurvivor({\n  baselines: selectedBaselines.length ? selectedBaselines : undefined,\n});',
  `// Explicit task-only beta selection; maintained default planner remains unchanged.\nconst plan = [{ flow: "systemd", baseline: "openclaw@2026.11.5-beta.1", version: "2026.11.5-beta.1", updateArgs: [] }];`);
replace('const harness = path.dirname(import.meta.filename);', `const harness = ${JSON.stringify(harness)};`);
replace('    let linger = false;', '    let linger = false;\n    let betaProof;\n    const context = { state, home, prefix, cli, packageRoot, asUser, cellDir, env, run, user, workspace };');
replace('    summary.cases.push(record);', '    summary.cases.push(record);\n    save(path.join(artifacts, "summary.json"), summary);');
replace('      asUser("baseline-doctor", cli, ["doctor", "--fix", "--non-interactive"]);',
  '      asUser("baseline-doctor", cli, ["doctor", "--fix", "--non-interactive"]);\n      asUser("baseline-channel", cli, ["config", "set", "update.channel", "stable"]);');
replace('      // This is the installed published updater.',
  '      oracle("baseline-state", "assert-state");\n      oracle("baseline-approvals", "assert-exec-approvals");\n      betaProof = captureBefore(context);\n      // This is the installed published updater.');
replace('      record.update = JSON.parse(update.stdout);\n      assert.equal(update.status, 0, `Published updater failed: ${record.update.reason}`);\n      record.afterRpc = probe("after");\n      record.after = unit("after-unit");\n      assertNativeUnit(record.after, { home, uid });',
  `      try { record.update = JSON.parse(update.stdout); } catch (error) { record.updateParseError = String(error); }
      // Every after-failure oracle runs before the update verdict; no refusal is reclassified.
      try { record.afterRpc = probe("after"); } catch (error) { record.afterRpcError = String(error); }
      try { record.after = unit("after-unit"); } catch (error) { record.afterUnitError = String(error); }
      record.betaProof = collectAfter(context, betaProof);
      for (const [name, command] of [["state-survived", "assert-state"], ["approvals-survived", "assert-exec-approvals"]]) {
        try { oracle(name, command); } catch (error) { betaProof.errors.push(String(error)); }
      }
      if (update.status !== 0) {
        assert.equal(record.after?.MainPID, record.before.MainPID, "Failed update disturbed baseline PID");
        assert.equal(record.afterRpc?.rpc?.server?.buildId, baseline.buildId, "Failed update changed serving build");
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8")), baseline);
        assert.equal(betaProof.afterConfigSha256, betaProof.beforeConfigSha256, "Failed update changed baseline config");
        assert.deepEqual(betaProof.afterHistory, betaProof.beforeHistory, "Failed update changed baseline history");
      }
      assert.deepEqual(betaProof.errors, [], "Original-state/capture/restore proof failed");
      assert.equal(update.status, 0, "Published beta update did not succeed");
      const targetAgentSchema = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).openclaw.schemaVersions.agent;
      assert(Number.isSafeInteger(targetAgentSchema));
      assert(betaProof.afterHistory.length > 0);
      for (const agent of betaProof.afterHistory) assert.equal(agent.userVersion, targetAgentSchema, "Live history did not reach candidate-owned schema");
      assertNativeUnit(record.after, { home, uid });`);
replace('      oracle("state-survived", "assert-state");\n      oracle("approvals-survived", "assert-exec-approvals");',
  '      record.originalStateAndRestoreVerified = true;');
replace('      // Preserve failure facts before stopping even when the update fails.',
  '      record.rawBeforeTeardown = captureVolatile(context, "native-before-teardown");\n      // Preserve failure facts before stopping even when the update fails.');
// Source-only generation is a syntax/review aid; it never installs or executes a product.
if (emitOnly) { fs.writeFileSync(1, source); process.exit(0); }
const generated = path.join(artifacts, "native-beta.generated.mjs");
fs.writeFileSync(generated, source);
fs.writeFileSync(path.join(artifacts, "fixture.json"), JSON.stringify({
  taskOnly: true, baseline, canonicalOwnerSha256: digest(owner), generatedSha256: digest(generated),
  candidateSha256: digest(candidate), adapterSha256: digest(fileURLToPath(import.meta.url)),
  evidenceSha256: digest(path.join(harness, "br-beta-native-evidence.mjs")),
  expectedSource: "bcae09093b5a06099cd3a3f0f3d5f4e4b499ad7f", pairedNativeRed: "not run; retained c2 actual beta failure and compatible 20a unit RED; see input tuple",
}, null, 2) + "\n");
try {
  const result = spawnSync(process.execPath, [generated, path.resolve(candidate), artifacts, baseline], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { manifestTree(artifacts); }
