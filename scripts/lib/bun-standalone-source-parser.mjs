import { spawnSync } from "node:child_process";
import * as nodeModule from "node:module";
import { parse } from "@babel/parser";
import { parse as parseJavaScript } from "acorn";
import { createStandaloneParser } from "./bun-standalone-parser.mjs";

const stripSource =
  'import { stripTypeScriptTypes } from "node:module"; import fs from "node:fs"; ' +
  'process.stdout.write(stripTypeScriptTypes(fs.readFileSync(0, "utf8"), { mode: "strip" }));';

function eraseTypesForAnalysis(contents) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(contents, { mode: "strip" });
  }
  // The experimental Bun host lacks this Node API. Node is already a build prerequisite.
  const result = spawnSync("node", ["--input-type=module", "--eval", stripSource], {
    input: contents,
    encoding: "utf8",
    maxBuffer: Buffer.byteLength(contents) + (1 << 20),
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Original-source AOT analysis needs the repository-supported Node type stripper. " +
        (result.error?.message ?? result.stderr),
      { cause: result.error },
    );
  }
  return result.stdout;
}

function assertAnalysisOffsets(contents, erased) {
  if (contents.length !== erased.length) {
    throw new Error("TypeScript analysis changed source length");
  }
  for (let index = 0; index < contents.length; index += 1) {
    if (
      contents[index] !== erased[index] &&
      (!/[\t ]/u.test(erased[index]) || /[\r\n]/u.test(contents[index]))
    ) {
      throw new Error(`TypeScript analysis changed source offsets at ${index}`);
    }
  }
}

export function standaloneSourceLoader(filename) {
  if (filename.endsWith(".tsx")) {
    return "tsx";
  }
  if (filename.endsWith(".jsx")) {
    return "jsx";
  }
  return /\.[cm]?ts$/.test(filename) ? "ts" : "js";
}

/** Keep source offsets and TypeScript annotations while the packaging adapters edit syntax. */
export function createStandaloneSourceParser() {
  return createStandaloneParser((contents, options = {}) => {
    try {
      return parse(contents, {
        sourceType: options.sourceType ?? "module",
        allowReturnOutsideFunction: options.allowReturnOutsideFunction ?? false,
        allowAwaitOutsideFunction: options.allowAwaitOutsideFunction ?? false,
        allowImportExportEverywhere: options.allowImportExportEverywhere ?? false,
        plugins: ["estree", "typescript", "decorators-legacy"],
      }).program;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      try {
        // Babel cannot parse typed async arrows in conditional consequents. Analyze
        // an offset-preserving copy; the compiler still receives the original types.
        const erased = eraseTypesForAnalysis(contents);
        assertAnalysisOffsets(contents, erased);
        return parseJavaScript(erased, {
          ...options,
          ecmaVersion: "latest",
          sourceType: options.sourceType ?? "module",
        });
      } catch (cause) {
        error.cause = cause;
        throw error;
      }
    }
  });
}
