#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import {
  checkChangelogLayout,
  loadChangelogCollection,
  loadReleaseChangelog,
  splitChangelog,
  writeReleaseChangelog,
} from "./lib/release-changelog.mjs";

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      ref: { type: "string" },
      version: { type: "string" },
      file: { type: "string" },
      record: { type: "boolean" },
      json: { type: "boolean" },
      "records-only": { type: "boolean" },
      check: { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1) {
    throw new Error("Expected one command: read, collection, write, split, check");
  }
  const params = {
    rootDir: values.root ?? process.cwd(),
    ref: values.ref,
    version: values.version,
  };
  if (command === "read") {
    const result = loadReleaseChangelog(params);
    if (values.record && result.record === null) {
      throw new Error(`No contribution record for ${result.version}`);
    }
    process.stdout.write(
      values.json ? `${JSON.stringify(result)}\n` : values.record ? result.record : result.section,
    );
  } else if (command === "collection") {
    process.stdout.write(
      loadChangelogCollection({ ...params, recordsOnly: values["records-only"] }),
    );
  } else if (command === "check") {
    console.log(JSON.stringify(checkChangelogLayout(params)));
  } else if (command === "split" || command === "write") {
    if (values.ref) {
      throw new Error("Writes cannot target a Git ref");
    }
    if (command === "split") {
      console.log(JSON.stringify(splitChangelog({ rootDir: params.rootDir, check: values.check })));
    } else {
      if (!values.file) {
        throw new Error("write requires --file (use - for stdin)");
      }
      const result = writeReleaseChangelog({
        ...params,
        section: fs.readFileSync(values.file === "-" ? 0 : values.file, "utf8"),
      });
      console.log(
        JSON.stringify({
          version: result.version,
          sourcePath: result.sourcePath,
          recordPath: result.recordPath,
        }),
      );
    }
  } else {
    throw new Error("Expected command: read, collection, write, split, check");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
