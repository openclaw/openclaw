#!/usr/bin/env node
// Runs iOS simulator tests with CI's xcodebuild flags and prints a short result summary.
// Usage: pnpm ios:test [Suite | Target[/Suite[/test]] ...]; no selectors runs the OpenClaw scheme.
// IOS_SIM picks a simulator by name or UDID; otherwise a booted iPhone, then the first available.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { findUnmatchedSelectors } from "./lib/ios-test-results.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const iosRoot = path.join(resolveRepoRoot(import.meta.url), "apps", "ios");
const unitTargets = new Set(["OpenClawTests", "OpenClawLogicTests"]);
const uiTarget = "OpenClawUITests";

type Simulator = { udid: string; name: string; state: string };

function fail(message: string): never {
  console.error(`ios:test: ${message}`);
  process.exit(1);
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function resolveSelectors(args: string[]): { scheme: string; selectors: string[] } {
  const selectors = args.map((arg) =>
    arg.includes("/") || unitTargets.has(arg) || arg === uiTarget ? arg : `OpenClawTests/${arg}`,
  );
  const targets = new Set(selectors.map((selector) => selector.split("/")[0]));
  for (const target of targets) {
    if (!unitTargets.has(target) && target !== uiTarget) {
      fail(
        `unknown test target ${target}. Use OpenClawTests, OpenClawLogicTests or OpenClawUITests; ` +
          "run OpenClawWatchTests through the OpenClawWatchApp scheme (apps/ios/README.md).",
      );
    }
  }
  if (targets.has(uiTarget) && targets.size > 1) {
    fail("run OpenClawUITests selectors separately from unit test selectors.");
  }
  return { scheme: targets.has(uiTarget) ? uiTarget : "OpenClaw", selectors };
}

function selectSimulator(): Simulator {
  const listed = JSON.parse(capture("xcrun", ["simctl", "list", "devices", "available", "--json"]));
  const devices = Object.values(listed.devices as Record<string, Simulator[]>).flat();
  const requested = process.env.IOS_SIM;
  if (requested) {
    return (
      devices.find((device) => device.udid === requested || device.name === requested) ??
      fail(`no available simulator named ${requested}.`)
    );
  }
  const iPhones = devices.filter((device) => device.name.startsWith("iPhone"));
  return (
    iPhones.find((device) => device.state === "Booted") ??
    iPhones[0] ??
    fail("no available iPhone simulator.")
  );
}

function xcresult(bundle: string, section: "summary" | "tests") {
  return JSON.parse(
    capture("xcrun", [
      "xcresulttool",
      "get",
      "test-results",
      section,
      "--path",
      bundle,
      "--compact",
    ]),
  );
}

function failBeforeTests(log: string, status: number | null): never {
  const lines = readFileSync(log, "utf8").split("\n");
  // Compiler diagnostics start unindented; their indented excerpts repeat the message.
  const errors = [...new Set(lines.filter((line) => /^\S.*\berror: /.test(line)))].slice(0, 20);
  console.error((errors.length > 0 ? errors : lines.slice(-40)).join("\n"));
  fail(`xcodebuild exited ${status} before running tests; the full log path is printed above.`);
}

const { scheme, selectors } = resolveSelectors(process.argv.slice(2));
const simulator = selectSimulator();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(iosRoot, "build", "TestResults");
const bundle = path.join(outputDir, `${stamp}.xcresult`);
const log = path.join(outputDir, `${stamp}.log`);
mkdirSync(outputDir, { recursive: true });

console.log(
  `ios:test: ${selectors.length > 0 ? selectors.join(" ") : `all ${scheme} tests`} ` +
    `on ${simulator.name} (${simulator.udid})\nios:test: log ${path.relative(process.cwd(), log)}`,
);
capture("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);

// Keep xcodebuild output in a file: simulator log forwarding can stall timed tests
// when nobody drains the pipe (see scripts/lib/swift-toolchain.sh).
const logFd = openSync(log, "w");
const xcodebuild = spawnSync(
  "xcodebuild",
  [
    "-project",
    "OpenClaw.xcodeproj",
    "-scheme",
    scheme,
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,id=${simulator.udid}`,
    "-derivedDataPath",
    "build/DerivedData",
    "-resultBundlePath",
    bundle,
    "-parallel-testing-enabled",
    "NO",
    // Xcode 27's simulator diagnostics collection can stall for minutes after tests pass.
    "-collect-test-diagnostics",
    "never",
    ...selectors.map((selector) => `-only-testing:${selector}`),
    "test",
  ],
  { cwd: iosRoot, stdio: ["ignore", logFd, logFd] },
);
closeSync(logFd);

if (!existsSync(bundle)) {
  failBeforeTests(log, xcodebuild.status);
}
const summary = xcresult(bundle, "summary");
if (xcodebuild.status !== 0 && summary.passedTests + summary.failedTests === 0) {
  failBeforeTests(log, xcodebuild.status);
}
for (const failure of summary.testFailures ?? []) {
  // Swift Testing expands captured values, which can be whole files; the xcresult keeps them.
  const lines = String(failure.failureText).split("\n");
  const shown = lines.slice(0, 6).join("\n  ") + (lines.length > 6 ? "\n  …" : "");
  console.log(`✘ ${failure.targetName}/${failure.testIdentifierString}\n  ${shown}`);
}
console.log(
  `ios:test: ${summary.result}: ${summary.passedTests} passed, ${summary.failedTests} failed, ` +
    `${summary.skippedTests} skipped\nios:test: results ${path.relative(process.cwd(), bundle)}`,
);
const unmatched = findUnmatchedSelectors(xcresult(bundle, "tests"), selectors);
if (unmatched.length > 0) {
  fail(`no tests ran for ${unmatched.join(", ")}; check the target, suite and test names.`);
}
if (xcodebuild.status !== 0) {
  process.exit(1);
}
