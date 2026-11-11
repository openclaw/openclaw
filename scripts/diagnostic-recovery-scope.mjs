// Diagnostic-only adapter: retain the changed-check plan, replacing its full
// core-test invocation with the existing CI stripe owner. Never import in product code.
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
  assert.equal(receipts.length, 6, "need central and all five stripe receipts");
  assert.deepEqual(receipts.map((receipt) => receipt.row).sort(),
    ["checks", "stripe-1", "stripe-2", "stripe-3", "stripe-4", "stripe-5"]);
  for (const receipt of receipts) {
    assert.equal(receipt.planSha256, digest(readFileSync(path.join(directory, "plan.json"))));
    assert.equal(receipt.source, plan.source);
    assert.deepEqual(receipt.files, plan.files);
  }
  const completed = receipts.flatMap((receipt) => receipt.completed);
  assert.deepEqual(completed.map(({ id }) => id).sort(), plan.invocations.map(({ id }) => id).sort(),
    "every planned invocation must complete exactly once");
  for (const entry of completed) {
    assert.deepEqual(entry.command, plan.invocations.find(({ id }) => id === entry.id).command);
    assert.equal(entry.status, 0, "failed invocation: " + entry.id);
  }
  console.log(JSON.stringify({ source: plan.source, files: plan.files,
    originalCommands: plan.commands.length, completedInvocations: completed.length,
    stripedGraphs: plan.stripes.flatMap(({ graphs }) => graphs) }, null, 2));
} else {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "diagnostic runner is CI-only");
  const { createChangedCheckPlan, createPnpmManagedCommand } = await loadOwner("check-changed.mts");
  const { detectChangedLanes, getChangedCoreTestPaths } = await loadOwner("changed-lanes.mts");
  const { TSGO_CORE_TEST_SHARDS, selectTsgoCoreTestStripe } =
    await loadOwner("lib/tsgo-core-test-shards.mts");
  const lanes = detectChangedLanes(files);
  const commands = createChangedCheckPlan(lanes, { base, head: "HEAD" }).commands;
  const replacements = commands.flatMap((command, index) =>
    command.bin === undefined && command.args.length === 1 && command.args[0] === "tsgo:core:test"
      ? [index] : []);
  assert.equal(replacements.length, 1, "expected exactly one full core-test command");
  const replacement = replacements[0];
  assert.ok(commands.every((command, index) => !command.coreTestCheck ||
    command.coreTestCheck === "checkBoundary" ||
    (index === replacement && command.coreTestCheck === "checkTypes")),
    "unexpected changed-check callback");
  const stripes = [1, 2, 3, 4, 5].map((stripe) => {
    const graphs = selectTsgoCoreTestStripe(stripe + "/5");
    assert.ok(graphs?.length);
    return { stripe, graphs: graphs.map(({ name, config }) => ({ name, config })) };
  });
  // Compare multisets, not just sets: omissions and duplicate graph ownership fail.
  assert.deepEqual(stripes.flatMap(({ graphs }) => graphs.map(({ config }) => config)).sort(),
    TSGO_CORE_TEST_SHARDS.map(({ config }) => config).sort());
  const invocations = [
    ...commands.flatMap((command, index) => index === replacement ? [] : [{
      id: "command-" + index, row: "checks", originalIndex: index, command: identity(command),
    }]),
    ...stripes.map(({ stripe }) => ({
      id: "stripe-" + stripe, row: "stripe-" + stripe, originalIndex: replacement,
      command: { name: "core test stripe " + stripe + "/5", bin: "node",
        args: ["scripts/run-tsgo-core-test-shards.mjs", "--stripe", stripe + "/5", "--concurrency", "2"] },
    })),
  ];
  const plan = {
    base, source: source(), files: files.map((file) => ({ path: file, sha256: digest(readFileSync(file)) })),
    commands: commands.map(identity), replacement, stripes, invocations,
    coreTestCoverage: "Full canonical stripes replace checkTypes consumer narrowing; checkBoundary is retained.",
  };
  if (mode === "plan") {
    mkdirSync(directory, { recursive: true });
    save(path.join(directory, "plan.json"), plan);
    console.log(JSON.stringify(plan, null, 2));
  } else {
    assert.equal(mode, "run");
    const saved = json(path.join(directory, "plan.json"));
    assert.deepEqual(plan, saved, "source bytes, canonical plan and stripe accounting must match preparation");
    const selected = invocations.filter((entry) => entry.row === row);
    assert.ok(selected.length, "unknown diagnostic row");
    const { runManagedCommand } = await loadOwner("lib/managed-child-process.mts");
    let coreTestCheck;
    if (selected.some(({ originalIndex }) => commands[originalIndex].coreTestCheck === "checkBoundary")) {
      const paths = getChangedCoreTestPaths(lanes);
      assert.ok(paths, "canonical boundary callback requires eligible changed paths");
      const { createChangedCoreTestCheck } = await loadOwner("run-tsgo-core-test-shards.mts");
      const { resolveLocalCheckEnv } = await loadOwner("lib/local-check-runtime.mts");
      const { createSparseTsgoSkipEnv } = await loadOwner("lib/tsgo-sparse-guard.mts");
      coreTestCheck = createChangedCoreTestCheck(paths, createSparseTsgoSkipEnv(resolveLocalCheckEnv()));
    }
    const receipt = { row, source: plan.source, files: plan.files,
      planSha256: digest(readFileSync(path.join(directory, "plan.json"))), completed: [] };
    const output = path.join(process.env.RUNNER_TEMP, "recovery-scope-receipts");
    mkdirSync(output, { recursive: true });
    let failure = 0;
    for (const entry of selected) {
      const command = row === "checks" ? commands[entry.originalIndex] : entry.command;
      const managed = command.bin ? command : createPnpmManagedCommand(command);
      console.log(JSON.stringify({ id: entry.id, command: entry.command }));
      const startedAt = performance.now();
      let status = 1;
      try {
        // Preserve the canonical in-process boundary callback, not just its CLI label.
        // Its cached inventories normally narrow checkTypes; this diagnostic deliberately
        // runs every graph through independent full stripes instead (recorded in plan.json).
        status = command.coreTestCheck === "checkBoundary"
          ? await coreTestCheck.checkBoundary()
          : await runManagedCommand({ bin: managed.bin, args: managed.args, env: managed.env ?? process.env });
      } catch (error) {
        console.error(error);
      }
      receipt.completed.push({ id: entry.id, command: entry.command, status, durationMs: performance.now() - startedAt });
      save(path.join(output, row + ".json"), receipt);
      failure ||= status;
      // Match the owner: collect ordinary failures, stop admission on cancellation/timeout.
      if (status === 124 || status >= 128) {
        failure = status;
        break;
      }
    }
    process.exitCode = failure;
  }
}
