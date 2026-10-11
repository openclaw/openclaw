import fs from "node:fs/promises";
import path from "node:path";
import pMap, { pMapSkip } from "p-map";
import * as ts from "typescript/unstable/ast";
import { listRepoFilesSync } from "./check-file-utils.js";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";

type RuntimeSourceGuardrailFile = {
  relativePath: string;
  source: string;
};

const WEAK_RANDOM_SAME_LINE_PATTERN =
  /(?:Date\.now[^\r\n]*Math\.random|Math\.random[^\r\n]*Date\.now)/u;
const PATH_JOIN_CALL_PATTERN = /path\s*\.\s*join\s*\(/u;
const OS_TMPDIR_CALL_PATTERN = /os\s*\.\s*tmpdir\s*\(/u;
const FILE_READ_CONCURRENCY = 24;
const DEFAULT_GUARDRAIL_SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.test-harness\.tsx?$/,
  /\.test-support\.tsx?$/,
  /\.suite\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests|test-helpers|test-utils|test-support)[\\/]/,
  /[\\/][^\\/]*test-helpers(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-utils(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-harness(?:\.[^\\/]+)?\.ts$/,
  /[\\/][^\\/]*test-support(?:\.[^\\/]+)?\.ts$/,
];

function shouldSkipGuardrailRuntimeSource(relativePath: string): boolean {
  return DEFAULT_GUARDRAIL_SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function mightContainDynamicTmpdirJoin(source: string): boolean {
  if (!source.includes("path") || !source.includes("join") || !source.includes("tmpdir")) {
    return false;
  }
  return (
    (source.includes("path.join") || PATH_JOIN_CALL_PATTERN.test(source)) &&
    (source.includes("os.tmpdir") || OS_TMPDIR_CALL_PATTERN.test(source)) &&
    source.includes("`") &&
    source.includes("${")
  );
}

function isNamedCall(
  node: ts.Node | undefined,
  object: string,
  method: string,
): node is ts.CallExpression {
  return Boolean(
    node &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === object &&
    node.expression.name.text === method,
  );
}

function hasDynamicTmpdirJoin(sourceFile: ts.SourceFile): boolean {
  const containsTemplate = (node: ts.Node): true | undefined =>
    ts.isTemplateExpression(node) ? true : node.forEachChild(containsTemplate);
  const visit = (node: ts.Node): true | undefined => {
    if (isNamedCall(node, "path", "join")) {
      const first = node.arguments[0];
      if (
        isNamedCall(first, "os", "tmpdir") &&
        first.arguments.length === 0 &&
        node.arguments
          .slice(1)
          .some(
            (argument) =>
              argument.getText(sourceFile).startsWith("`") && containsTemplate(argument),
          )
      ) {
        return true;
      }
    }
    return node.forEachChild(visit);
  };
  return visit(sourceFile) === true;
}

function listTrackedRuntimeSourceFiles(repoRoot: string): string[] {
  return listRepoFilesSync(repoRoot, {
    roots: ["src", "extensions"],
    includeFile: (relativePath) =>
      (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) &&
      !shouldSkipGuardrailRuntimeSource(relativePath),
  }).map((relativePath) => path.join(repoRoot, relativePath));
}

async function readRuntimeSourceFiles(
  repoRoot: string,
  absolutePaths: string[],
): Promise<RuntimeSourceGuardrailFile[]> {
  return await pMap(
    absolutePaths,
    async (absolutePath) => {
      try {
        return {
          relativePath: path.relative(repoRoot, absolutePath),
          source: await fs.readFile(absolutePath, "utf8"),
        };
      } catch {
        // File tracked by git but deleted on disk (e.g. pending deletion).
        return pMapSkip;
      }
    },
    { concurrency: FILE_READ_CONCURRENCY, stopOnError: false },
  );
}

async function main() {
  const repoRoot = process.cwd();
  const files = await readRuntimeSourceFiles(repoRoot, listTrackedRuntimeSourceFiles(repoRoot));
  using parser = createNativeTypeScriptParser({ cwd: repoRoot });
  const offenders: string[] = [];
  const weakRandomMatches: string[] = [];

  for (const file of files) {
    const source = file.source;
    const mightContainWeakRandom = source.includes("Date.now") && source.includes("Math.random");
    if (
      mightContainDynamicTmpdirJoin(source) &&
      hasDynamicTmpdirJoin(parser.parseSourceFile(file.relativePath, source))
    ) {
      offenders.push(file.relativePath);
    }
    if (mightContainWeakRandom && WEAK_RANDOM_SAME_LINE_PATTERN.test(source)) {
      weakRandomMatches.push(file.relativePath);
    }
  }

  if (offenders.length === 0 && weakRandomMatches.length === 0) {
    return;
  }

  if (offenders.length > 0) {
    console.error("Dynamic os.tmpdir()/path.join() template paths found:");
    for (const offender of offenders) {
      console.error(`- ${offender}`);
    }
  }
  if (weakRandomMatches.length > 0) {
    console.error("Weak Date.now()+Math.random() same-line IDs found:");
    for (const offender of weakRandomMatches) {
      console.error(`- ${offender}`);
    }
  }
  process.exitCode = 1;
}

await main();
