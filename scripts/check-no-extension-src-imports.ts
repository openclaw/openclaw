import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";

const FORBIDDEN_REPO_SRC_IMPORT = /["'](?:\.\.\/)+(?:src\/)[^"']+["']/;

function isProductionExtensionFile(filePath: string): boolean {
  return !(
    filePath.endsWith("/runtime-api.ts") ||
    filePath.endsWith("\\runtime-api.ts") ||
    filePath.includes(".test.") ||
    filePath.includes(".spec.") ||
    filePath.includes(".fixture.") ||
    filePath.includes(".snap") ||
    filePath.includes("test-harness") ||
    filePath.includes("test-support") ||
    filePath.includes("test-helpers") ||
    filePath.includes("test-fixtures") ||
    filePath.includes("/__tests__/") ||
    filePath.includes("/fixtures/") ||
    filePath.includes("/test/") ||
    filePath.includes("/tests/") ||
    filePath.includes("/coverage/") ||
    filePath.includes("/dist/") ||
    filePath.includes("/node_modules/")
  );
}

function collectExtensionSourceFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: (filePath) => isCodeFile(filePath) && isProductionExtensionFile(filePath),
  });
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const files = collectExtensionSourceFiles(extensionsDir);
  const offenders: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    if (FORBIDDEN_REPO_SRC_IMPORT.test(content)) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    console.error("Production extension files must not import the repo src/ tree directly.");
    for (const offender of offenders.toSorted()) {
      console.error(`- ${relativeToCwd(offender)}`);
    }
    console.error(
      "Publish a focused openclaw/plugin-sdk/<subpath> surface or use the extension's own public barrel instead.",
    );
    process.exit(1);
  }

  console.log(
    `OK: production extension files avoid direct repo src/ imports (${files.length} checked).`,
  );
}

main();
