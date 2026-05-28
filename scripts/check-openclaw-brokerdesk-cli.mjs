#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const COMMANDS = Object.freeze([
  { command: "status", expected: "brokerdesk:quote:status" },
  { command: "quote-read", expected: "brokerdesk:quote:read" },
  { command: "quote-pump", expected: "brokerdesk:quote:pump" },
  { command: "quote-ui", expected: "brokerdesk:quote:ui" },
  { command: "stock-list", expected: "brokerdesk:hft:stock-list" },
  { command: "paper-loop", expected: "brokerdesk:paper-loop" },
  { command: "paper-loop-check", expected: "brokerdesk:paper-loop:check" },
  { command: "paper-trigger", expected: "brokerdesk:paper-hft:trigger" },
  { command: "paper-trigger-check", expected: "brokerdesk:paper-hft:trigger:check" },
  { command: "capital-overseas-rotation", expected: "brokerdesk:capital:overseas-rotation" },
  {
    command: "capital-overseas-rotation-check",
    expected: "brokerdesk:capital:overseas-rotation:check",
  },
  { command: "capital-master-checklist", expected: "brokerdesk:capital:master-flow-checklist" },
]);

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
}

function runPnpm(args) {
  return spawnSync("pnpm", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

function normalize(text) {
  return String(text ?? "")
    .trim()
    .replace(/\r\n/g, "\n");
}

function runActiveTaskCheck() {
  const pnpmProbe = runPnpm(["check:openclaw-automation-active-task"]);
  const pnpmDetail = normalize(
    pnpmProbe.error
      ? String(pnpmProbe.error.message || pnpmProbe.error)
      : `${pnpmProbe.stdout ?? ""}\n${pnpmProbe.stderr ?? ""}`,
  );
  if (pnpmProbe.status === 0 && !pnpmProbe.error) {
    return { ok: true, detail: pnpmDetail };
  }

  const missingScript =
    pnpmDetail.includes('Command "check:openclaw-automation-active-task" not found') ||
    pnpmDetail.includes("ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL");
  if (!missingScript) {
    return { ok: false, detail: pnpmDetail };
  }

  // Fallback: verify at least one ACTIVE automation heartbeat carries required guard keywords.
  const codexHome =
    process.env.CODEX_HOME ||
    (process.platform === "win32" && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, ".codex")
      : "");
  if (!codexHome) {
    return {
      ok: false,
      detail: `${pnpmDetail}\nactive-task fallback failed: CODEX_HOME unavailable`,
    };
  }

  const automationsRoot = path.join(codexHome, "automations");
  if (!fs.existsSync(automationsRoot)) {
    return {
      ok: false,
      detail: `${pnpmDetail}\nactive-task fallback failed: automations directory missing (${automationsRoot})`,
    };
  }

  const required = ["BLOCKED_BY_ACTIVE_TASK", "unrelated dirty changes", "只在準備修改的檔案"];
  const candidates = [];
  for (const entry of fs.readdirSync(automationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const tomlPath = path.join(automationsRoot, entry.name, "automation.toml");
    if (!fs.existsSync(tomlPath)) {
      continue;
    }
    const text = normalize(fs.readFileSync(tomlPath, "utf8"));
    const active = /^status\s*=\s*"ACTIVE"$/m.test(text);
    const hasGuard = required.every((token) => text.includes(token));
    candidates.push({ id: entry.name, active, hasGuard });
  }

  const passed = candidates.some((item) => item.active && item.hasGuard);
  if (passed) {
    const activeIds = candidates
      .filter((item) => item.active && item.hasGuard)
      .map((item) => item.id)
      .join(",");
    return {
      ok: true,
      detail: `${pnpmDetail}\nfallback: active-task guard verified via automation.toml (${activeIds})`,
    };
  }

  const snapshot = candidates
    .map((item) => `${item.id}:active=${item.active},guard=${item.hasGuard}`)
    .join("; ");
  return {
    ok: false,
    detail: `${pnpmDetail}\nactive-task fallback failed: no ACTIVE automation with required guard (${snapshot || "no automation.toml"})`,
  };
}

const checks = [];
let ok = true;

const activeTask = runActiveTaskCheck();
checks.push({
  name: "active_task_gate",
  ok: activeTask.ok,
  detail: activeTask.detail,
});
if (!activeTask.ok) {
  ok = false;
}

const syntax = run(process.execPath, ["--check", "scripts/openclaw-brokerdesk-cli.mjs"]);
checks.push({
  name: "wrapper_syntax",
  ok: syntax.status === 0,
  detail: syntax.status === 0 ? "ok" : normalize(syntax.stderr || syntax.stdout),
});
if (syntax.status !== 0) {
  ok = false;
}

const helpDirect = run(process.execPath, ["scripts/openclaw-brokerdesk-cli.mjs", "help"]);
const dashHelpDirect = run(process.execPath, ["scripts/openclaw-brokerdesk-cli.mjs", "--help"]);
const helpDirectOutput = normalize(`${helpDirect.stdout ?? ""}\n${helpDirect.stderr ?? ""}`);
const dashHelpDirectOutput = normalize(
  `${dashHelpDirect.stdout ?? ""}\n${dashHelpDirect.stderr ?? ""}`,
);
const helpAliasPassed =
  helpDirect.status === 0 &&
  dashHelpDirect.status === 0 &&
  helpDirectOutput.length > 0 &&
  helpDirectOutput === dashHelpDirectOutput;
checks.push({
  name: "help_alias_consistency",
  ok: helpAliasPassed,
  detail: helpAliasPassed
    ? "help and --help outputs match"
    : normalize(
        `helpStatus=${helpDirect.status ?? "null"} dashHelpStatus=${dashHelpDirect.status ?? "null"}\n---help---\n${helpDirectOutput}\n---dash-help---\n${dashHelpDirectOutput}`,
      ),
});
if (!helpAliasPassed) {
  ok = false;
}

const helpProbe = runPnpm(["brokerdesk:cli", "help"]);
const helpOutput = normalize(
  helpProbe.error
    ? String(helpProbe.error.message || helpProbe.error)
    : `${helpProbe.stdout ?? ""}\n${helpProbe.stderr ?? ""}`,
);
const missingHelpCommands = COMMANDS.map((item) => item.command).filter(
  (command) => !helpOutput.includes(command),
);
const missingHelpRoutes = COMMANDS.map((item) => item.expected).filter(
  (route) => !helpOutput.includes(route),
);
const helpPassed =
  helpProbe.status === 0 &&
  !helpProbe.error &&
  missingHelpCommands.length === 0 &&
  missingHelpRoutes.length === 0;
checks.push({
  name: "help_contains_all_routes",
  ok: helpPassed,
  detail: helpPassed
    ? "all commands/routes listed"
    : normalize(
        `missingCommands=${missingHelpCommands.join(",") || "none"} missingRoutes=${missingHelpRoutes.join(",") || "none"}\n${helpOutput}`,
      ),
});
if (!helpPassed) {
  ok = false;
}

const unknownProbe = runPnpm(["brokerdesk:cli", "unknown-cmd"]);
const unknownOutput = normalize(
  unknownProbe.error
    ? String(unknownProbe.error.message || unknownProbe.error)
    : `${unknownProbe.stdout ?? ""}\n${unknownProbe.stderr ?? ""}`,
);
const unknownPassed =
  unknownProbe.status !== 0 && !unknownProbe.error && unknownOutput.includes("unknown command");
checks.push({
  name: "unknown_command_rejected",
  ok: unknownPassed,
  detail: unknownPassed ? "unknown command rejected" : unknownOutput,
});
if (!unknownPassed) {
  ok = false;
}

const docsPath = "docs/cli/brokerdesk-cli.md";
let docsOutput = "";
let docsReadError = "";
try {
  docsOutput = normalize(fs.readFileSync(docsPath, "utf8"));
} catch (error) {
  docsReadError = normalize(error instanceof Error ? error.message : String(error));
}
const missingDocsCommands =
  docsReadError.length > 0
    ? []
    : COMMANDS.map((item) => item.command).filter(
        (command) => !docsOutput.includes("`" + command + "`"),
      );
const missingDocsRoutes =
  docsReadError.length > 0
    ? []
    : COMMANDS.map((item) => item.expected).filter(
        (route) => !docsOutput.includes("`" + route + "`"),
      );
const docsPassed =
  docsReadError.length === 0 && missingDocsCommands.length === 0 && missingDocsRoutes.length === 0;
checks.push({
  name: "docs_contains_all_commands",
  ok: docsPassed,
  detail: docsPassed
    ? "all commands documented"
    : docsReadError ||
      `missingCommands=${missingDocsCommands.join(",") || "none"} missingRoutes=${missingDocsRoutes.join(",") || "none"}`,
});
if (!docsPassed) {
  ok = false;
}

const packageJsonPath = "package.json";
let packageScripts = {};
let packageReadError = "";
try {
  const packageRaw = fs.readFileSync(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageRaw);
  packageScripts =
    packageJson && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
} catch (error) {
  packageReadError = normalize(error instanceof Error ? error.message : String(error));
}
const missingPackageRoutes =
  packageReadError.length > 0
    ? []
    : COMMANDS.map((item) => item.expected).filter((route) => !(route in packageScripts));
const packageRoutesPassed = packageReadError.length === 0 && missingPackageRoutes.length === 0;
checks.push({
  name: "package_scripts_include_all_routes",
  ok: packageRoutesPassed,
  detail: packageRoutesPassed
    ? "all mapped routes exist in package scripts"
    : packageReadError || `missingRoutes=${missingPackageRoutes.join(",") || "none"}`,
});
if (!packageRoutesPassed) {
  ok = false;
}

for (const item of COMMANDS) {
  const probe = runPnpm(["brokerdesk:cli", item.command, "--dry-run"]);
  const combined = normalize(
    probe.error
      ? String(probe.error.message || probe.error)
      : `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`,
  );
  const passed = probe.status === 0 && !probe.error && combined.includes(item.expected);
  checks.push({
    name: `route_${item.command}`,
    ok: passed,
    detail: passed ? item.expected : combined,
  });
  if (!passed) {
    ok = false;
  }
}

const report = {
  schema: "openclaw.brokerdesk.cli.check.v1",
  generatedAt: new Date().toISOString(),
  ok,
  checks,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(ok ? 0 : 1);
