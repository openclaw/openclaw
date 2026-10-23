#!/usr/bin/env node
import fs from "node:fs";
import { parseReleaseVersion } from "./lib/release-version.mjs";

try {
  const args = process.argv.slice(2);
  const version = parseReleaseVersion((args[0] ?? "").replace(/^v/, ""));
  if (args.length !== 1 || !version || version.channel === "alpha") {
    throw new Error("Expected one stable or beta release version: YYYY.M.PATCH[-beta.N]");
  }
  const tag = `v${version.version}`;
  const histories = ["state", "agent"].map((kind) => {
    const file = `docs/reference/database-schemas/${kind}-schema-history.md`;
    const before = fs.readFileSync(file, "utf8");
    let stamped = 0;
    const after = before.replace(
      /^(\|[\t ]*\d+(?:-\d+)?[\t ]*\|[^\r\n]*\|[\t ]*)Unreleased([\t ]*\|[\t ]*\r?)$/gm,
      (_row, prefix, suffix) => {
        stamped++;
        return `${prefix}\`${tag}\`${suffix}`;
      },
    );
    return { file, before, after, stamped };
  });
  for (const { file, before, after, stamped } of histories) {
    if (after !== before) {
      fs.writeFileSync(file, after);
    }
    console.log(`${file}: stamped ${stamped} schema rows with ${tag}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
