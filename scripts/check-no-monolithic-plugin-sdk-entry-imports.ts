import fs from "node:fs";
import path from "node:path";
import { discoverOpenClawPlugins } from "../src/plugins/discovery.js";

const ROOT_IMPORT_PATTERN = /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']openclaw\/plugin-sdk["']/;

function main() {
  const discovery = discoverOpenClawPlugins({});
  const bundledEntryFiles = [
    ...new Set(discovery.candidates.filter((c) => c.origin === "bundled").map((c) => c.source)),
  ];

  const offenders: string[] = [];
  for (const entryFile of bundledEntryFiles) {
    let content = "";
    try {
      content = fs.readFileSync(entryFile, "utf8");
    } catch {
      continue;
    }
    if (ROOT_IMPORT_PATTERN.test(content)) {
      offenders.push(entryFile);
    }
  }

  if (offenders.length > 0) {
    console.error("Bundled plugin entrypoints must not import monolithic openclaw/plugin-sdk.");
    for (const file of offenders.toSorted()) {
      const relative = path.relative(process.cwd(), file) || file;
      console.error(`- ${relative}`);
    }
    console.error("Use openclaw/plugin-sdk/<channel> for channel plugins or /core for others.");
    process.exit(1);
  }

  console.log(
    `OK: bundled entrypoints use scoped plugin-sdk subpaths (${bundledEntryFiles.length} checked).`,
  );
}

main();
