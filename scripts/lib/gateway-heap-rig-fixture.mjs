import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand } from "./managed-child-process.mts";

/** Generate synthetic state at its final path before Gateway startup; keep the rig config. */
export async function prepareHeapRigFixture({
  gib,
  port,
  env,
  sourceRoot = fileURLToPath(new URL("../../", import.meta.url)),
}) {
  const started = performance.now();
  assert(Number.isSafeInteger(gib) && gib >= 0);
  assert(env.OPENCLAW_STATE_DIR && env.OPENCLAW_CONFIG_PATH);
  const destination = path.resolve(env.OPENCLAW_STATE_DIR);
  assert(!existsSync(destination), "Synthetic fixture state directory must not exist");
  const run = async (script, args) => {
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--import",
        path.join(sourceRoot, "scripts/tsx.mjs"),
        path.join(sourceRoot, script),
        ...args,
      ],
      cwd: sourceRoot,
      env,
      stdio: "inherit",
      requireProcessTreeExit: process.platform !== "win32",
    });
    assert.equal(code, 0, "Synthetic fixture preparation failed");
  };
  // The generator binds its isolated config/environment before importing storage owners.
  await run("scripts/perf/team-shape-fixture.ts", [
    "--state-dir",
    destination,
    "--sessions",
    "5000",
    "--agents",
    "1",
    "--runs",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--local-placements",
    "0",
    "--transcript-mib",
    "64",
    "--port",
    String(port),
  ]);
  if (gib > 0) {
    await run("scripts/perf/session-resource-loader-fixture.mjs", [
      "--root",
      destination,
      "--complete-gib",
      String(gib),
    ]);
  }
  // Verification uses the outer rig config, after the generator closes its native owners.
  await run("scripts/perf/team-shape-fixture-verify.mjs", [sourceRoot]);
  const summary = JSON.parse(
    readFileSync(path.join(destination, "team-shape-summary.json"), "utf8"),
  );
  const files = [
    "agents/main/agent/openclaw-agent.sqlite",
    "state/openclaw.sqlite",
    "client/credentials.sqlite",
  ];
  return {
    destination,
    sessionCount: summary.sessionCount,
    completion: summary.completion,
    databaseBytes: Object.fromEntries(
      files.map((file) => [file, statSync(path.join(destination, file)).size]),
    ),
    verification: path.join(destination, "offline-integrity-proof.json"),
    elapsedMs: performance.now() - started,
  };
}
