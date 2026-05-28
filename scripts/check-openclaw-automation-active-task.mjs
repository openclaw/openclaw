#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_GUARDS = ["BLOCKED_BY_ACTIVE_TASK", "unrelated dirty changes", "只在準備修改的檔案"];

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function parseToml(text) {
  const record = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2].trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      record[key] = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (/^\d+$/.test(rawValue)) {
      record[key] = Number(rawValue);
    } else {
      record[key] = rawValue;
    }
  }
  return record;
}

function walkAutomationTomls(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) {
    return files;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "automation.toml") {
        files.push(fullPath);
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

function buildReport(repoRoot, codexHome) {
  const automationsRoot = path.join(codexHome, "automations");
  const tomlFiles = walkAutomationTomls(automationsRoot);
  const automations = tomlFiles.map((filePath) => {
    const parsed = parseToml(fs.readFileSync(filePath, "utf8"));
    const status = String(parsed.status ?? "");
    const prompt = String(parsed.prompt ?? "");
    const active = status === "ACTIVE";
    const hasGuard = REQUIRED_GUARDS.every((token) => prompt.includes(token));
    return {
      file: normalizePath(path.relative(codexHome, filePath)),
      id: String(parsed.id ?? ""),
      scope: String(parsed.name ?? ""),
      status,
      targetThreadId: String(parsed.target_thread_id ?? ""),
      active,
      hasGuard,
    };
  });

  const active = automations.filter((item) => item.active);
  const failures = [];
  const warnings = [];

  if (active.length === 0) {
    warnings.push({ code: "ACTIVE_AUTOMATION_MISSING" });
  }

  for (const item of active) {
    if (!item.hasGuard) {
      failures.push({
        code: "ACTIVE_AUTOMATION_PROMPT_GUARD_MISSING",
        id: item.id,
        file: item.file,
      });
    }
  }

  for (const item of active) {
    if (!item.targetThreadId) {
      warnings.push({
        code: "ACTIVE_HEARTBEAT_TARGET_THREAD_MISSING",
        id: item.id,
        file: item.file,
      });
    }
  }

  return {
    schema: "openclaw.automation-active-task.v1",
    generatedAt: new Date().toISOString(),
    repoRoot: normalizePath(repoRoot),
    codexHome,
    status: failures.length > 0 ? "failed" : "passed",
    automationCount: automations.length,
    activeAutomationCount: active.length,
    activeWithGuardCount: active.filter((item) => item.hasGuard).length,
    activeAutomations: active.map((item) => ({
      id: item.id,
      status: item.status,
      targetThreadId: item.targetThreadId,
      file: item.file,
    })),
    failures,
    warnings,
  };
}

function toHuman(report) {
  const lines = [
    "OpenClaw automation active-task check",
    `Repo: ${report.repoRoot}`,
    `Codex home: ${report.codexHome}`,
    `Status: ${report.status}`,
    `Active automations: ${report.activeAutomationCount}/${report.automationCount}`,
  ];
  for (const entry of report.activeAutomations) {
    lines.push(`[ACTIVE] ${entry.id} target=${entry.targetThreadId || "missing"}`);
  }
  for (const warning of report.warnings) {
    lines.push(`[WARN] ${warning.code}${warning.id ? ` ${warning.id}` : ""}`);
  }
  for (const failure of report.failures) {
    lines.push(`[FAIL] ${failure.code}${failure.id ? ` ${failure.id}` : ""}`);
  }
  return lines.join("\n");
}

function main() {
  const argSet = new Set(process.argv.slice(2));
  const checkMode = argSet.has("--check");
  const jsonMode = argSet.has("--json");
  const repoRoot = process.cwd();
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));

  const report = buildReport(repoRoot, codexHome);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${toHuman(report)}\n`);
  }
  if (checkMode && report.status !== "passed") {
    process.exitCode = 1;
  }
}

main();
