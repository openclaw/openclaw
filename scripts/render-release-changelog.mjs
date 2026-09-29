#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkReleaseDocsMirrors, renderReleaseDocsMirror } from "./lib/release-docs-mirror.mjs";

try {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: process.cwd() },
      version: { type: "string" },
      source: { type: "string", multiple: true },
      output: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const rootDir = path.resolve(values.root);
  if (values.check) {
    if (values.source || values.output) {
      throw new Error("--check cannot be combined with --source or --output");
    }
    const checked = checkReleaseDocsMirrors({ rootDir, version: values.version });
    process.stdout.write(
      `Checked ${checked.length} docs mirror(s)${checked.length ? `: ${checked.join(", ")}` : ""}\n`,
    );
  } else {
    const rendered = renderReleaseDocsMirror({
      rootDir,
      version: values.version,
      sources: values.source,
    });
    if (values.output) {
      const output = path.resolve(values.output);
      const physicalOutput = fs.existsSync(output)
        ? fs.realpathSync(output)
        : path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
      const relative = path
        .relative(fs.realpathSync(rootDir), physicalOutput)
        .split(path.sep)
        .join("/");
      if (
        relative === "CHANGELOG/records" ||
        relative.startsWith("CHANGELOG/records/") ||
        relative === "docs" ||
        relative.startsWith("docs/")
      ) {
        throw new Error(
          "Mirror output must not overwrite docs sources or frozen contribution records",
        );
      }
      fs.writeFileSync(output, rendered);
    } else {
      process.stdout.write(rendered);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
