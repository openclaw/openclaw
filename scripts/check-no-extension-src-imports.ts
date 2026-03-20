import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_REPO_SRC_IMPORT = /["'](?:\.\.\/)+(?:src\/)[^"']+["']/;
const LEGACY_ALLOWLIST = new Set<string>([
  "extensions/brave/src/brave-web-search-provider.ts",
  "extensions/discord/src/directory-config.ts",
  "extensions/firecrawl/src/firecrawl-search-provider.ts",
  "extensions/google/src/gemini-web-search-provider.ts",
  "extensions/googlechat/runtime-api.ts",
  "extensions/imessage/runtime-api.ts",
  "extensions/moonshot/src/kimi-web-search-provider.ts",
  "extensions/perplexity/src/perplexity-web-search-provider.ts",
  "extensions/signal/runtime-api.ts",
  "extensions/signal/src/accounts.ts",
  "extensions/slack/src/directory-config.ts",
  "extensions/slack/src/runtime-api.ts",
  "extensions/telegram/src/directory-config.ts",
  "extensions/whatsapp/src/directory-config.ts",
  "extensions/xai/src/grok-web-search-provider.ts",
  "extensions/xai/web-search.ts",
]);

function isSourceFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(filePath);
}

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
    filePath.includes("/__tests__/") ||
    filePath.includes("/coverage/") ||
    filePath.includes("/dist/") ||
    filePath.includes("/node_modules/")
  );
}

function collectExtensionSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isSourceFile(fullPath) && isProductionExtensionFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files;
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
    const actionable = offenders
      .map((offender) => path.relative(process.cwd(), offender) || offender)
      .filter((relative) => !LEGACY_ALLOWLIST.has(relative));

    if (actionable.length === 0) {
      console.log(
        `OK: production extension files avoid new direct repo src/ imports (${files.length} checked; ${offenders.length} legacy allowlisted).`,
      );
      return;
    }

    console.error("Production extension files must not import the repo src/ tree directly.");
    for (const offender of actionable.toSorted((a, b) => a.localeCompare(b))) {
      console.error(`- ${offender}`);
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
