#!/usr/bin/env node
// Pairs a fresh iPhone simulator with an isolated local Gateway through the real onboarding UI.
// Usage: pnpm ios:sim:pair [--profile ios-sim] [--app <OpenClaw.app>]
// The port comes from the profile's gateway.port. IOS_SIM reuses a simulator by name or UDID;
// otherwise a new "iPhone 17" is created and deleted again if pairing fails.
// Prints the simulator UDID on the last line. Requires mobilebuildmcp and a running Gateway.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "ios-sim" },
    app: {
      type: "string",
      default: path.join(
        repoRoot,
        "apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/OpenClaw.app",
      ),
    },
  },
});
const profile = values.profile;
const app = path.resolve(values.app);
let createdUdid: string | undefined;

function fail(message: string): never {
  if (createdUdid) {
    spawnSync("xcrun", ["simctl", "delete", createdUdid]);
  }
  console.error(`ios:sim:pair: ${message}`);
  process.exit(1);
}

// `quiet` keeps child output out of the failure message when argv or the screen holds a secret.
function run(command: string, args: string[], options: { quiet?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = options.quiet ? "" : `:\n${result.stderr || result.stdout || result.error}`;
    fail(`${command} ${args.slice(0, 2).join(" ")} failed${detail}`);
  }
  return result.stdout;
}

// The built CLI runs as is; run-node refuses to rebuild while a Gateway runs from the same build.
function openclaw(args: string[], options: { quiet?: boolean } = {}): string {
  return run("node", ["openclaw.mjs", "--profile", profile, ...args], options).trim();
}

function gatewayListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

// A Gateway that was just started can open its port a few seconds after the process is up.
async function waitForGateway(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await gatewayListening(port)) {
      return true;
    }
    await delay(1000);
  }
  return false;
}

function simulatorUdid(): string {
  const requested = process.env.IOS_SIM;
  if (!requested) {
    createdUdid = run("xcrun", [
      "simctl",
      "create",
      `openclaw-pair-${Date.now()}`,
      "iPhone 17",
    ]).trim();
    return createdUdid;
  }
  const listed = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"]));
  const devices = Object.values(listed.devices as Record<string, { udid: string; name: string }[]>);
  return (
    devices.flat().find((device) => device.udid === requested || device.name === requested)?.udid ??
    fail(`no available simulator named ${requested}.`)
  );
}

// Preflight before creating anything.
if (spawnSync("mobilebuildmcp", ["--version"]).status !== 0) {
  fail("mobilebuildmcp is not installed; see Setup in .agents/skills/ios-e2e/SKILL.md.");
}
if (!existsSync(app)) {
  fail(`no app at ${app}. Build it first (mobilebuildmcp simulator build) or pass --app.`);
}
const bundleId = run("/usr/libexec/PlistBuddy", [
  "-c",
  "Print :CFBundleIdentifier",
  path.join(app, "Info.plist"),
]).trim();
const port = Number(openclaw(["config", "get", "gateway.port"]).split("\n").at(-1));
if (!Number.isInteger(port) || port <= 0) {
  fail(`profile ${profile} has no gateway.port; see Setup in .agents/skills/ios-e2e/SKILL.md.`);
}
if (!(await waitForGateway(port))) {
  fail(
    `nothing listens on 127.0.0.1:${port}. Start the profile's Gateway first: ` +
      `node scripts/run-node.mjs --profile ${profile} gateway --bind loopback`,
  );
}
// The setup code carries a short-lived bootstrap token; it stays out of output, including
// failure messages of the commands that receive it.
const setupCode = openclaw(["qr", "--setup-code-only", "--url", `ws://127.0.0.1:${port}`], {
  quiet: true,
})
  .split("\n")
  .at(-1);
if (!setupCode) {
  fail(`could not create a setup code for profile ${profile}.`);
}

const udid = simulatorUdid();
run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
run("xcrun", ["simctl", "install", udid, app]);

const ui = (args: string[], options: { quiet?: boolean } = {}) =>
  run("mobilebuildmcp", ["ui-automation", ...args, "--simulator-id", udid], options);
// Snapshot rows read `ref|action|role|label|value|id`; screens behind a sheet are listed too,
// so match on the label or id and take the last (frontmost) match.
function ref(pattern: RegExp): string {
  const rows = ui(["snapshot-ui", "--style", "minimal"]).split("\n");
  const row = rows.findLast((line) => pattern.test(line));
  return row?.split("|")[0]?.trim() || fail(`no element matches ${pattern} on screen.`);
}
const tap = (pattern: RegExp) => ui(["tap", "--element-ref", ref(pattern)]);
// The MobileBuildMCP daemon ends any request after 30 s, so each wait stays below that.
const waitFor = (selector: string[], options: { quiet?: boolean } = {}) =>
  ui(["wait-for-ui", "--predicate", "exists", ...selector, "--timeout-ms", "25000"], options);

run("xcrun", [
  "simctl",
  "launch",
  "--terminate-running-process",
  udid,
  bundleId,
  "--openclaw-reset-onboarding",
  // The selectors below match English labels; a reused simulator may run another language.
  "-AppleLanguages",
  "(en)",
  "-AppleLocale",
  "en_US",
]);
waitFor(["--label", "Continue", "--role", "button"]);
tap(/\|Continue\|/);
tap(/\|Connect Manually\|/);
ui(["type-text", "--element-ref", ref(/Enter setup code/), "--text", setupCode], { quiet: true });
tap(/\|Apply\|/);
// Only the success screen shows this button. The setup code is still on screen until then.
waitFor(["--label", "Go to Chat", "--role", "button"], { quiet: true });
tap(/\|Go to Chat\|/);
waitFor(["--identifier", "chat-message-input"]);
createdUdid = undefined;
console.log(`ios:sim:pair: paired ${bundleId} with ${profile} on 127.0.0.1:${port}`);
console.log(udid);
