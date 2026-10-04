import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanClosedMockFactories } from "./lib/mock-factory-scan.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import {
  compareRatchetSets,
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";
import { getImportGraphAliases, resolveImportSpecifiers } from "./test-projects.test-support.mts";

const BASELINE = "config/test-mock-exports-baseline.txt";
const MAX_BUFFER = 256 * 1024 * 1024;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const HEADER = [
  "# Exact first-party vi.mock/vi.doMock factories without real-module pass-through.",
  "# New factories require importOriginal/vi.importActual pass-through or an adjacent",
  "# // mock-isolation: reason annotation. Existing entries may only shrink.",
  "# JSON tuple: source path, specifier, factory/target SHA-256, duplicate ordinal.",
  "",
].join("\n");

function parseBaseline(source: string) {
  const entries = new Set<string>();
  for (const line of source.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      typeof value[2] !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value[2]) ||
      typeof value[3] !== "number" ||
      !Number.isSafeInteger(value[3]) ||
      value[3] < 1 ||
      entries.has(line) ||
      JSON.stringify(value) !== line
    ) {
      throw new Error(`Invalid ${BASELINE} entry`);
    }
    entries.add(line);
  }
  return entries;
}

function currentFactories(root: string, staged: boolean, ref?: string) {
  const files = execFileSync(
    "git",
    ref
      ? ["ls-tree", "-r", "--name-only", "-z", ref]
      : ["ls-files", "-z", ...(staged ? [] : ["--cached", "--others", "--exclude-standard"])],
    { cwd: root, maxBuffer: MAX_BUFFER },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const inventory = new Set(files);
  const grep = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-z",
      "-F",
      "-w",
      ...(ref ? [] : staged ? ["--cached"] : ["--untracked"]),
      "-e",
      "mock",
      "-e",
      "doMock",
      ...(ref ? [ref] : []),
      "--",
      ".",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER },
  );
  if (grep.error || (grep.status !== 0 && grep.status !== 1)) {
    throw grep.error ?? new Error(grep.stderr || "Could not inventory mock factories");
  }
  const codeFiles = grep.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => (ref ? file.slice(ref.length + 1) : file))
    .filter((file) => EXTENSIONS.includes(path.extname(file)) && !/\.d\.[cm]?ts$/u.test(file));
  const readSources = (names: string[]) =>
    staged || ref
      ? loadRatchetSources(root, names, ref ?? "")
      : new Map(
          names.flatMap((file): [string, string][] => {
            const full = path.join(root, file);
            return fs.existsSync(full) ? [[file, fs.readFileSync(full, "utf8")]] : [];
          }),
        );
  const sources = readSources(codeFiles);
  const candidates = [...sources];
  const manifests = readSources(
    files.filter(
      (file) =>
        file === "tsconfig.json" ||
        /^(?:(?:packages|extensions)\/[^/]+\/)?package\.json$/u.test(file),
    ),
  );
  const aliases = getImportGraphAliases(root, manifests);
  const aliasResolutions = new Map<string, string[]>();
  using parser = createNativeTypeScriptParser({ cwd: root });
  const syntax = parser.parseSourceFiles(
    candidates.map(([fileName, text]) => ({ fileName, text })),
  );
  const diagnostics = parser.getSyntacticDiagnostics();
  if (diagnostics.length > 0) {
    throw new Error(`Mock factory scan requires valid syntax: ${diagnostics[0]!.text}`);
  }
  const entries = new Set<string>();
  const locations = new Map<string, string>();
  syntax.forEach((source, index) => {
    const file = candidates[index]![0];
    const resolve = (specifier: string) =>
      resolveImportSpecifiers(
        file,
        specifier,
        inventory,
        EXTENSIONS,
        aliases,
        aliasResolutions,
        true,
      );
    const occurrences = new Map<string, number>();
    for (const finding of scanClosedMockFactories(source, resolve)) {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([resolve(finding.specifier).toSorted(), finding.fingerprint]))
        .digest("hex");
      const identity = JSON.stringify([file, finding.specifier, fingerprint]);
      const ordinal = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, ordinal);
      const entry = JSON.stringify([file, finding.specifier, fingerprint, ordinal]);
      entries.add(entry);
      locations.set(entry, `${file}:${finding.line}: ${finding.specifier}`);
    }
  });
  return { entries, locations };
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("Mock factory ratchet requires a Git base commit");
    }
    const reference = loadRatchetReference(root, base, BASELINE, parseBaseline);
    // Bootstrap and old branch bases derive existing debt from that revision's
    // sources; a missing ledger never authorizes new factories or allowances.
    const allowed = reference ?? currentFactories(root, false, base).entries;
    const current = currentFactories(root, args.staged);
    const write = (entries: Set<string>) =>
      fs.writeFileSync(
        path.join(root, BASELINE),
        HEADER + [...entries].toSorted().join("\n") + "\n",
      );
    if (args.prune && reference === null) {
      const additions = compareRatchetSets(current.entries, allowed).added;
      if (
        reportRatchetFailures([
          {
            title: "New mock factories cannot enter the initial baseline:",
            entries: additions.map((entry) => current.locations.get(entry)!),
          },
        ])
      ) {
        return 1;
      }
      write(current.entries);
      console.log(`Initialized ${BASELINE}: ${current.entries.size} exact factories.`);
      return 0;
    }
    const baseline = loadRatchetSnapshot(root, BASELINE, args.staged, parseBaseline);
    const delta = compareRatchetSets(current.entries, baseline);
    const expanded = compareRatchetSets(baseline, allowed).added;
    if (
      reportRatchetFailures(
        [
          {
            title: "First-party mock factories must preserve real exports or explain isolation:",
            entries: delta.added.map((entry) => current.locations.get(entry)!),
          },
          { title: "The mock factory baseline may only shrink:", entries: expanded },
        ],
        "Spread the real module via importOriginal/vi.importActual, or place // mock-isolation: reason immediately above the mock call when real state must stay isolated.",
      )
    ) {
      return 1;
    }
    if (args.prune) {
      write(current.entries);
      console.log(
        `Pruned ${BASELINE}: ${baseline.size} -> ${current.entries.size} exact factories.`,
      );
      return 0;
    }
    if (
      reportRatchetFailures([
        { title: `Shrink ${BASELINE} (run with --prune):`, entries: delta.removed },
      ])
    ) {
      return 1;
    }
    console.log(`Mock factory ratchet OK: ${current.entries.size} grandfathered factories.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
