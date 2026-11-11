// Diagnostic-only follow-up to run 43027772560/1: execute only its two failed
// checks. The accepted full 39-invocation / 28-graph proof remains separate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const base = "d9751e2ff705fab4c43a078d60a96f1e9682cefd";
const files = [
  "src/infra/update-recovery-backup-reader.ts",
  "src/infra/update-recovery-backup-reader.test.ts",
  "docs/install/updating.md",
];
const baseline = "config/test-mock-exports-baseline.txt";
// These exact debts became obsolete when 2b4b7cf9fa38 added the already-reviewed
// isolation annotations. Only the canonical --prune owner may write the baseline.
const obsoleteEntries = new Set([
  '["src/infra/device-identity-async.test.ts","../state/openclaw-state-db-cache.js","2cf06eac56993305e3908aaafa49655e996f77ebe4c4bd3ef0b3cf509c078950",1]',
  '["src/projects/project-source-env.test.ts","../state/openclaw-state-db-cache.js","f08596344df0b822d4f4989273bd7e9dba7c18e6639afd16cd6f3c83a00999bd",1]',
]);
const [mode, directory, row] = process.argv.slice(2);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const identity = (command) => ({
  name: command.name,
  bin: command.bin ?? "pnpm",
  args: command.args,
  ...(command.coreTestCheck ? { coreTestCheck: command.coreTestCheck } : {}),
});
const loadOwner = (file) => import(pathToFileURL(path.resolve("scripts", file)).href);

if (mode === "collect") {
  const plan = json(path.join(directory, "plan.json"));
  const receipts = readdirSync(row).filter((file) => file.endsWith(".json"))
    .map((file) => json(path.join(row, file)));
  assert.deepEqual(receipts.map((receipt) => receipt.row), ["checks"]);
  for (const receipt of receipts) {
    assert.equal(receipt.planSha256, digest(readFileSync(path.join(directory, "plan.json"))));
    assert.equal(receipt.source, plan.source);
    assert.deepEqual(receipt.files, plan.files);
  }
  const completed = receipts.flatMap((receipt) => receipt.completed);
  assert.deepEqual(completed.map(({ id }) => id).sort(), plan.invocations.map(({ id }) => id).sort(),
    "every selected follow-up invocation must complete exactly once");
  for (const entry of completed) {
    assert.deepEqual(entry.command, plan.invocations.find(({ id }) => id === entry.id).command);
    assert.equal(entry.status, 0, "failed invocation: " + entry.id);
  }
  console.log(JSON.stringify({ source: plan.source, files: plan.files, coverage: plan.coverage,
    originalCommands: plan.commands.length, completedInvocations: completed.length,
    stripedGraphs: [] }, null, 2));
} else {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "diagnostic runner is CI-only");
  assert.ok(mode === "prepare" || mode === "run", "unknown diagnostic mode");
  const { createChangedCheckPlan, createPnpmManagedCommand } = await loadOwner("check-changed.mts");
  const { detectChangedLanes } = await loadOwner("changed-lanes.mts");
  const { runManagedCommand } = await loadOwner("lib/managed-child-process.mts");
  const commands = createChangedCheckPlan(detectChangedLanes(files), { base, head: "HEAD" }).commands;
  // Select existing owner commands, not copied lint/path classification rules.
  const selectedNames = ["first-party mock export ratchet", "lint core changed files"];
  const invocations = selectedNames.map((name) => {
    const matches = commands.flatMap((command, index) => command.name === name ? [index] : []);
    assert.equal(matches.length, 1, "expected one canonical follow-up command: " + name);
    const index = matches[0];
    assert.ok(!commands[index].coreTestCheck, "follow-up cannot execute a type callback");
    return { id: "command-" + index, row: "checks", originalIndex: index, command: identity(commands[index]) };
  });
  if (mode === "prepare") {
    const before = readFileSync(baseline, "utf8");
    const lines = before.split("\n");
    const removed = lines.filter((line) => obsoleteEntries.has(line));
    assert.ok(removed.length === 0 || (removed.length === 2 && new Set(removed).size === 2),
      "baseline must contain both obsolete entries or already have neither");
    const prune = createPnpmManagedCommand({ ...commands[invocations[0].originalIndex],
      args: [...commands[invocations[0].originalIndex].args, "--prune"] });
    const status = await runManagedCommand({ bin: prune.bin, args: prune.args, env: prune.env });
    assert.equal(status, 0, "canonical mock baseline pruning failed");
    assert.equal(readFileSync(baseline, "utf8"),
      lines.filter((line) => !obsoleteEntries.has(line)).join("\n"),
      "canonical prune must remove only the two reviewed obsolete entries");
  }
  const plan = {
    base, source: source(),
    files: [...files, baseline].map((file) => ({ path: file, sha256: digest(readFileSync(file)) })),
    coverage: "Failed-check follow-up only: mock export ratchet and targeted core lint; no type graphs rerun.",
    priorFullProof: { run: 43027772560, attempt: 1, source: "f0f993fc46a1911560d623c62d56a625ec23ffa5" },
    commands: commands.map(identity), invocations,
  };
  if (mode === "prepare") {
    mkdirSync(directory, { recursive: true });
    save(path.join(directory, "plan.json"), plan);
    console.log(JSON.stringify(plan, null, 2));
  } else {
    const saved = json(path.join(directory, "plan.json"));
    assert.deepEqual(plan, saved, "source bytes and canonical follow-up plan must match preparation");
    assert.equal(row, "checks", "only the failed-check follow-up row is admitted");
    const receipt = { row, source: plan.source, files: plan.files,
      planSha256: digest(readFileSync(path.join(directory, "plan.json"))), completed: [] };
    const output = path.join(process.env.RUNNER_TEMP, "recovery-scope-receipts");
    mkdirSync(output, { recursive: true });
    let failure = 0;
    for (const entry of invocations) {
      const command = commands[entry.originalIndex];
      const managed = command.bin ? command : createPnpmManagedCommand(command);
      console.log(JSON.stringify({ id: entry.id, command: entry.command }));
      const startedAt = performance.now();
      let status = 1;
      try {
        status = await runManagedCommand({ bin: managed.bin, args: managed.args, env: managed.env ?? process.env });
      } catch (error) {
        console.error(error);
      }
      receipt.completed.push({ id: entry.id, command: entry.command, status, durationMs: performance.now() - startedAt });
      save(path.join(output, row + ".json"), receipt);
      failure ||= status;
      if (status === 124 || status >= 128) {
        failure = status;
        break;
      }
    }
    process.exitCode = failure;
  }
}
