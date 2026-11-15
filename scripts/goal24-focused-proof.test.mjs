// Synthetic orchestration proof only: never executes contributor source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const driver = fileURLToPath(new URL("./goal24-focused-proof.mjs", import.meta.url));
for (const scenario of ["pass", "zero", "prefix-zero", "prefix-partial", "install-failure"]) {
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
  ] : args[1] === "src/agents/agent-tools.prefix-stability.test.ts"
    ? ["offers the session's tool definitions and refuses tools outside the replayed authority",
       ...Array.from({length:13}, (_, i) => "prefix case " + i)]
    : ["suppresses already-replayed DM turns while preserving delivery-only context after restart"];
  if (args[1].includes("prefix-stability")) {
    if (fs.readFileSync("scenario", "utf8") === "prefix-zero") names.length = 0;
    if (fs.readFileSync("scenario", "utf8") === "prefix-partial") names.pop();
  }
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
        scenario === "pass"
          ? "pass"
          : scenario === "install-failure"
            ? "setup-failure"
            : "test-failure",
      );
      if (["zero", "prefix-zero"].includes(scenario)) {
        assert.match(summary.error, /selected zero tests/);
      }
      if (scenario === "prefix-partial") {
        assert.match(summary.error, /must execute all 14 cases/);
      }
      if (scenario === "pass") {
        const stages = summary.stages.filter((stage) => stage.tests);
        assert.equal(stages.length, 3);
        assert.deepEqual(stages[2].args.slice(0, 2), [
          "test",
          "src/agents/agent-tools.prefix-stability.test.ts",
        ]);
        assert.equal(stages[2].tests.length, 14);
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}

// Exercise the driver's actual preflight statements, without invoking Swift or
// contributor source on the operator host.
for (const version of ["6.3", "6.4", "7.0", "6.2", "unknown"]) {
  test("Swift minimum-toolchain preflight: " + version, () => {
    const source = fs.readFileSync(driver, "utf8");
    const start = source.indexOf('    summary.swift = capture("swift", ["--version"]);');
    const end = source.indexOf('    run("native-assets"', start);
    assert.ok(start >= 0 && end > start);
    const check = () =>
      vm.runInNewContext(source.slice(start, end), {
        assert,
        summary: {},
        capture: () => "Apple Swift version " + version + " (swiftlang-test)",
      });
    if (["6.3", "6.4", "7.0"].includes(version)) {
      assert.doesNotThrow(check);
    } else {
      assert.throws(check);
    }
  });
}
