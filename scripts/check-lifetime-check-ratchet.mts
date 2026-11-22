import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { changedProductionFiles, productionFile } from "./database-dialect-inventory.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  compareRatchetCounts,
  listRatchetRenames,
  loadRatchetSources,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

// Constructors and refusals of mid-request authority re-checks (AGENTS.md "Choose good
// compromises"; docs/gateway/security/trust-model.md). Admission, cancellation, secrets and
// data fences are not listed: they stay.
export const LIFETIME_CHECK_CALLS = [
  "captureOperatorToolGatewayAuthority",
  "resolveSessionRuntimeAuthority",
  "captureHttpRequestAuthority",
  "bindHttpResponseAuthority",
  "captureAdmittedRunActiveAssertion",
  "captureGatewayToolCallerAssertion",
  "captureGatewayToolReceiptAssertion",
  "captureMediaGenerationAdmission",
] as const;
const calls: ReadonlySet<string> = new Set(LIFETIME_CHECK_CALLS);
// Authority wording only: "<owner|lock|generation> is no longer current" is a data or ownership fence.
const refusals = [
  "authority changed",
  "authority is no longer active",
  "authority is no longer current",
  "request connection is no longer current",
  "changing before execution",
];
const roots = ["src", "extensions", "packages"];

/** Count syntax constructs, not lines, comments, declarations or identifier references. */
export function countLifetimeChecks(source: ts.SourceFile) {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
            ? callee.argumentExpression.text
            : undefined;
      if (name && calls.has(name)) {
        count += 1;
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) &&
      refusals.some((refusal) => node.text.toLowerCase().includes(refusal))
    ) {
      count += 1;
    }
    node.forEachChild(visit);
  };
  visit(source);
  return count;
}

function inventory(root: string, ref: string, staged: boolean, selected?: readonly string[]) {
  if (selected?.length === 0) {
    return new Map<string, number>();
  }
  const snapshot = ref !== "" || staged;
  const files = execFileSync(
    "git",
    [
      "--literal-pathspecs",
      ...(ref
        ? ["ls-tree", "-r", "--name-only", "-z", ref]
        : ["ls-files", "--cached", ...(staged ? [] : ["--others", "--exclude-standard"]), "-z"]),
      "--",
      ...(selected ?? roots),
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        productionFile(file) &&
        !file.endsWith(".sql") &&
        (snapshot || fs.existsSync(path.join(root, file))),
    );
  const unique = [...new Set(files)].toSorted();
  const texts = snapshot
    ? loadRatchetSources(root, unique, ref)
    : new Map(unique.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
  using parser = createNativeTypeScriptParser({ cwd: root });
  const sources = parser.parseSourceFiles(
    unique.map((fileName) => ({ fileName, text: texts.get(fileName)! })),
  );
  return new Map(unique.map((file, index) => [file, countLifetimeChecks(sources[index]!)]));
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const fullTree = argv.includes("--full-tree");
    const args = parseRatchetArgs(argv.filter((arg) => arg !== "--full-tree"));
    if (args.prune) {
      throw new Error("Lifetime check ratchet has no baseline to prune.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("Lifetime check ratchet requires a Git base commit.");
    }
    const renames = listRatchetRenames(root, base, args.staged, roots);
    const files = fullTree ? undefined : changedProductionFiles(root, base, args.staged);
    const current = inventory(root, "", args.staged, files);
    const previous = inventory(root, base, false, files);
    // Git-verified renames carry their old allowance, not a fresh zero-count baseline.
    for (const { from, to } of renames) {
      if (previous.has(from) && !previous.has(to) && !current.has(from) && current.has(to)) {
        previous.set(to, previous.get(from)!);
        previous.delete(from);
      }
    }
    const total = [...current.values()].reduce((sum, count) => sum + count, 0);
    console.log(
      `Lifetime checks (${fullTree ? "full tree" : "changed production files"}): ${total}.`,
    );
    if (fullTree) {
      const totals = new Map<string, number>();
      for (const [file, count] of current) {
        if (count > 0) {
          const owner = file.split("/").slice(0, 2).join("/");
          totals.set(owner, (totals.get(owner) ?? 0) + count);
        }
      }
      for (const [owner, count] of [...totals].toSorted(([a], [b]) => a.localeCompare(b))) {
        console.log(`${owner}: ${count}`);
      }
    }
    const increases = compareRatchetCounts(current, previous).increased;
    if (
      reportRatchetFailures(
        [
          {
            title: "Lifetime check counts may only fall:",
            entries: increases.map(
              ({ entry, allowed, current: count }) =>
                `${entry}: ${allowed} -> ${count} (+${count - allowed})`,
            ),
          },
        ],
        "authority is checked once when a request starts; do not add a mid-request re-check. " +
          "See AGENTS.md#choose-good-compromises (https://github.com/openclaw/openclaw/blob/main/AGENTS.md#choose-good-compromises).",
      )
    ) {
      return 1;
    }
    console.log(`Lifetime check ratchet OK: no per-file growth against ${base}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
