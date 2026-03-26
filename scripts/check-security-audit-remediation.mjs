#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runAsScript, toLine } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECURITY_AUDIT_FILES = [
  "src/security/audit.ts",
  "src/security/audit-channel.ts",
  "src/security/audit-extra.async.ts",
  "src/security/audit-extra.sync.ts",
];

function getProperty(node, name) {
  return node.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteral(property.name) && property.name.text === name)),
  );
}

function readStringValue(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

export function findSecurityAuditRemediationViolations(content, filePath) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const relativeFile = path.relative(repoRoot, filePath);
  const violations = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "findings" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const finding = node.arguments[0];
      const severityProperty = getProperty(finding, "severity");
      const remediationProperty = getProperty(finding, "remediation");
      const titleProperty = getProperty(finding, "title");
      const severity =
        severityProperty && ts.isPropertyAssignment(severityProperty)
          ? readStringValue(severityProperty.initializer)
          : null;
      if (severity === "warn" || severity === "critical") {
        const remediationValue =
          remediationProperty && ts.isPropertyAssignment(remediationProperty)
            ? readStringValue(remediationProperty.initializer)
            : null;
        if (!remediationProperty || remediationValue === "") {
          const title =
            titleProperty && ts.isPropertyAssignment(titleProperty)
              ? (readStringValue(titleProperty.initializer) ?? "(unknown title)")
              : "(unknown title)";
          violations.push({
            file: relativeFile,
            line: toLine(sourceFile, finding),
            severity,
            title,
            reason: `${severity} security audit finding is missing remediation guidance`,
            remediation:
              "Add a non-empty remediation field so warnings and critical audit findings always tell operators what to do next.",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export async function collectSecurityAuditRemediationViolations() {
  const violations = [];
  for (const relativePath of SECURITY_AUDIT_FILES) {
    const absPath = path.join(repoRoot, relativePath);
    const content = await fs.readFile(absPath, "utf8");
    violations.push(...findSecurityAuditRemediationViolations(content, absPath));
  }
  return violations.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.severity.localeCompare(right.severity) ||
      left.title.localeCompare(right.title),
  );
}

export async function main(argv = process.argv.slice(2), io = process) {
  const json = argv.includes("--json");
  const violations = await collectSecurityAuditRemediationViolations();
  if (violations.length === 0) {
    io.stdout.write(json ? "[]\n" : "security-audit-remediation: OK\n");
    return 0;
  }
  if (json) {
    io.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
  } else {
    io.stderr.write("security-audit-remediation: found violations:\n");
    for (const violation of violations) {
      io.stderr.write(
        `- ${violation.file}:${violation.line} [${violation.severity}] ${violation.title}\n  Fix: ${violation.remediation}\n`,
      );
    }
  }
  return 1;
}

runAsScript(import.meta.url, async () => {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
});
