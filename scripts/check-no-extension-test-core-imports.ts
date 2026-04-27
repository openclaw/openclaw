import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, relativeToCwd } from "./check-file-utils.js";

type Offender = { file: string; hint: string; line?: number; specifier?: string };

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

const STATIC_RELATIVE_MODULE_PATTERN = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;

const RELATIVE_CORE_HINT =
  "Use openclaw/plugin-sdk/testing or a focused plugin-sdk test/runtime subpath instead of core internals.";

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

function lineNumberForOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function resolvesToRepoSrc(filePath: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const resolved = path.resolve(path.dirname(filePath), specifier);
  const repoRelative = path.relative(process.cwd(), resolved).replaceAll(path.sep, "/");
  return repoRelative === "src" || repoRelative.startsWith("src/");
}

function collectRelativeCoreImportOffenders(filePath: string, content: string): Offender[] {
  const offenders: Offender[] = [];
  for (const match of content.matchAll(STATIC_RELATIVE_MODULE_PATTERN)) {
    const specifier = match[1];
    if (!specifier || !resolvesToRepoSrc(filePath, specifier)) {
      continue;
    }
    offenders.push({
      file: filePath,
      hint: RELATIVE_CORE_HINT,
      line: lineNumberForOffset(content, match.index ?? 0),
      specifier,
    });
  }
  return offenders;
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const files = collectExtensionTestFiles(extensionsDir);
  const offenders: Offender[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const rule of FORBIDDEN_PATTERNS) {
      if (!rule.pattern.test(content)) {
        continue;
      }
      offenders.push({ file, hint: rule.hint });
      break;
    }
    offenders.push(...collectRelativeCoreImportOffenders(file, content));
  }

  if (offenders.length > 0) {
    console.error(
      "Extension test files must stay on extension test bridges or public plugin-sdk surfaces.",
    );
    for (const offender of offenders.toSorted((a, b) => a.file.localeCompare(b.file))) {
      const location = offender.line
        ? `${relativeToCwd(offender.file)}:${offender.line}`
        : relativeToCwd(offender.file);
      const specifier = offender.specifier ? ` (${offender.specifier})` : "";
      console.error(`- ${location}${specifier}: ${offender.hint}`);
    }
    process.exit(1);
  }

  console.log(
    `OK: extension test files and support helpers avoid direct core test/internal imports (${files.length} checked).`,
  );
}

main();
