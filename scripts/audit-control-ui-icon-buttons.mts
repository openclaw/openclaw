#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIconFixtures } from "./lib/control-ui-icon-fixtures.mts";
import {
  createIconStyleContext,
  scanIconGridFit,
  selectIconFixtures,
} from "./lib/control-ui-icon-grid-fit.mts";

export function auditIconButtons(rootDir: string, files?: string[]) {
  const fixtures = loadIconFixtures(rootDir);
  const context = createIconStyleContext(rootDir);
  const targets = files?.length
    ? files.map((file) => path.resolve(rootDir, file))
    : fs
        .readdirSync(path.join(rootDir, "ui/src"), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".css"))
        .map((file) => path.join(rootDir, "ui/src", file))
        .toSorted();
  const findings = [];
  let checked = 0,
    unresolved = 0,
    sheets = 0;
  for (const file of targets) {
    const css = fs.readFileSync(file, "utf8");
    if (!/display:\s*(?:inline-)?grid/u.test(css)) {
      continue;
    }
    const candidates = selectIconFixtures(css, fixtures);
    if (!candidates.length) {
      continue;
    }
    const styles = context(file);
    const result = scanIconGridFit(css, candidates, styles.baseCss, styles);
    sheets++;
    checked += result.checked;
    unresolved += result.unresolved;
    for (const finding of result.findings) {
      findings.push({ stylesheet: path.relative(rootDir, file), ...finding });
    }
  }
  return {
    sourceFixtures: fixtures.length,
    stylesheets: targets.length,
    analyzedStylesheets: sheets,
    checkedAxes: checked,
    unresolvedAxes: unresolved,
    findings,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
      const root = args[++i];
      if (!root) {
        throw new Error("--root needs a checkout path");
      }
      rootDir = path.resolve(root);
    } else if (args[i] === "--check") {
      check = true;
    } else if (args[i] === "--help") {
      console.log(
        "Usage: node scripts/audit-control-ui-icon-buttons.mts [--root CHECKOUT] [--check] [CSS_FILE ...]",
      );
      process.exit(0);
    } else if (args[i]!.startsWith("--")) {
      throw new Error("Unknown option: " + args[i]);
    } else {
      files.push(args[i]!);
    }
  }
  const report = auditIconButtons(rootDir, files);
  console.log(JSON.stringify(report, null, 2));
  if (check && report.findings.length > 0) {
    process.exitCode = 1;
  }
}
