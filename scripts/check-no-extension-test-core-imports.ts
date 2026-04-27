import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, relativeToCwd } from "./check-file-utils.js";

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /["']openclaw\/plugin-sdk["']/,
    hint: "Use openclaw/plugin-sdk/<subpath> instead of the monolithic root entry.",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/test-utils["']/,
    hint: "Use openclaw/plugin-sdk/testing for the public extension test surface.",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/compat["']/,
    hint: "Use a focused public plugin-sdk subpath instead of compat.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:test-utils\/)[^"']+["']/,
    hint: "Use test/helpers/plugins/* for repo-only bundled extension test helpers.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/test-utils\/)[^"']+["']/,
    hint: "Use test/helpers/plugins/* for repo-only helpers, or openclaw/plugin-sdk/testing for public surfaces.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/plugins\/types\.js)["']/,
    hint: "Use public plugin-sdk/core types or test/helpers/plugins/* instead.",
  },
  {
    pattern: /["'](?:\.\.\/)+(?:src\/channels\/plugins\/contracts\/test-helpers\.js)["']/,
    hint: "Use openclaw/plugin-sdk/testing for channel contract test helpers.",
  },
];

const FORBIDDEN_TEST_SUPPORT_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern:
      /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](?:\.\.\/){2,}src\/(?:agents|channels|config|infra|plugins|routing|security|test-helpers|test-utils)\/[^"']+["']/,
    hint: "Use openclaw/plugin-sdk/testing or a focused plugin-sdk test/runtime subpath instead of core internals.",
  },
];

function isExtensionTestFile(filePath: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/u.test(filePath) || /\.e2e\.test\.[cm]?[jt]sx?$/u.test(filePath);
}

function isExtensionTestSupportFile(filePath: string): boolean {
  return /(?:^|[/\\])test-support(?:[/\\]|$)/u.test(filePath) && /\.[cm]?[jt]sx?$/u.test(filePath);
}

function collectExtensionTestFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: (filePath) =>
      isExtensionTestFile(filePath) || isExtensionTestSupportFile(filePath),
  });
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const files = collectExtensionTestFiles(extensionsDir);
  const offenders: Array<{ file: string; hint: string }> = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const rules = isExtensionTestSupportFile(file)
      ? [...FORBIDDEN_PATTERNS, ...FORBIDDEN_TEST_SUPPORT_PATTERNS]
      : FORBIDDEN_PATTERNS;
    for (const rule of rules) {
      if (!rule.pattern.test(content)) {
        continue;
      }
      offenders.push({ file, hint: rule.hint });
      break;
    }
  }

  if (offenders.length > 0) {
    console.error(
      "Extension test files must stay on extension test bridges or public plugin-sdk surfaces.",
    );
    for (const offender of offenders.toSorted((a, b) => a.file.localeCompare(b.file))) {
      console.error(`- ${relativeToCwd(offender.file)}: ${offender.hint}`);
    }
    process.exit(1);
  }

  console.log(
    `OK: extension test files and support helpers avoid direct core test/internal imports (${files.length} checked).`,
  );
}

main();
