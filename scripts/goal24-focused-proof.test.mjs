// Synthetic orchestration proof only: never executes contributor source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./goal24-focused-proof.mjs", import.meta.url));
for (const scenario of ["pass", "zero", "install-failure"]) {
  test("history orchestration: " + scenario, () => {
    const fixture = fs.mkdtempSync(path.join(path.dirname(driver), ".goal24-test-"));
    try {
      for (const dir of ["source", "bin", "tmp"]) {
        fs.mkdirSync(path.join(fixture, dir));
      }
      fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"commonjs"}');
      const fake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (path.basename(process.argv[1]) === "git") {
  if (args[0] === "rev-parse") console.log("eb919fb0d0b19dfa86c3e7055145b5a83ae27ef9");
  if (args[0] === "config") process.exit(1);
} else if (args[0] === "--version") {
  console.log("12.15.0");
} else if (args[0] === "install") {
  if (process.cwd().includes("install-failure")) process.exit(2);
} else {
  const names = args[1].includes("transcript-recent-text") ? [
    "bounds candidate coverage in physical rows", "does not bridge an oversized user barrier",
    "shares the 64 MiB candidate budget",
  ] : ["suppresses already-replayed DM turns while preserving delivery-only context after restart"];
  const scenario = fs.readFileSync("scenario", "utf8");
  const tests = scenario === "zero" ? [] : names.map(fullName => ({fullName,status:"passed",failureMessages:[]}));
  fs.writeFileSync(args.find(arg => arg.startsWith("--outputFile=")).slice(13), JSON.stringify({testResults:[{assertionResults:tests}]}));
}
`;
      for (const binary of ["git", "pnpm"]) {
        fs.writeFileSync(
          path.join(fixture, "bin", binary),
          fake.replace(
            'process.cwd().includes("install-failure")',
            JSON.stringify(scenario === "install-failure"),
          ),
          { mode: 0o700 },
        );
      }
      fs.writeFileSync(path.join(fixture, "source/scenario"), scenario);
      const result = spawnSync(process.execPath, [driver], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10000,
        env: {
          PATH: path.join(fixture, "bin") + path.delimiter + path.dirname(process.execPath),
          RUNNER_TEMP: path.join(fixture, "tmp"),
          GOAL24_PROOF: "history",
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: "Linux",
        },
      });
      const summary = JSON.parse(
        fs.readFileSync(path.join(fixture, "proof-output/summary.json"), "utf8"),
      );
      assert.equal(result.status, scenario === "pass" ? 0 : 1, JSON.stringify(summary));
      assert.equal(
        summary.outcome,
        scenario === "pass" ? "pass" : scenario === "zero" ? "test-failure" : "setup-failure",
      );
      if (scenario === "zero") {
        assert.match(summary.error, /selected zero tests/);
      }
      if (scenario === "pass") {
        assert.equal(summary.stages.filter((stage) => stage.tests).length, 2);
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}
