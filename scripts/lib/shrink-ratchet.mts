import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Owns file-backed baselines and the per-file count ratchet lifecycle, including
// base allowances, verified renames, pruning, and deterministic failure/shrink guidance.
// The chained-assertion ledger stays in type-assertion-guard-scope.mjs: it is live scope policy
// loaded by plain-JS oxlint, not a baseline, and folding it here would couple oxlint to git/fs.

export type RatchetCountDelta = { allowed: number; current: number; entry: string };

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const compareEntries = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function parseRatchetArgs(argv: string[]) {
  const args: { base?: string; prune: boolean; staged: boolean } = { prune: false, staged: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prune") {
      args.prune = true;
      continue;
    }
    if (arg === "--staged") {
      args.staged = true;
      continue;
    }
    if (arg === "--base" && argv[index + 1]) {
      args.base = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Unknown or incomplete argument: " + arg);
  }
  return args;
}

function readGitText(root: string, args: string[]) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ratchet-git-"));
  const output = path.join(temporary, "stdout");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(output, "wx", 0o600);
    // Baseline blobs can exceed execFileSync's pipe limit. Git writes directly
    // to a file; only a successful command may supply the complete snapshot.
    execFileSync("git", args, { cwd: root, stdio: ["ignore", descriptor, "ignore"] });
    return fs.readFileSync(output, "utf8");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function resolvesCommit(root: string, ref: string) {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveRatchetBase(root: string, options: { base?: string; staged: boolean }) {
  const resolved =
    options.base ??
    (options.staged ? ["HEAD"] : ["origin/main", "HEAD"]).find((ref) => resolvesCommit(root, ref));
  if (!resolved || options.staged) {
    return resolved ?? null;
  }

  // Branches own their grandfathered debt from the fork. Comparing against a
  // moving base tip turns unrelated cleanup there into a local expansion.
  try {
    return readGitText(root, ["merge-base", "HEAD", resolved]).trim();
  } catch {
    return resolved;
  }
}

export function loadRatchetSnapshot<T>(
  root: string,
  baselinePath: string,
  staged: boolean,
  parse: (source: string) => T,
) {
  const source = staged
    ? readGitText(root, ["show", ":" + baselinePath])
    : fs.readFileSync(path.join(root, baselinePath), "utf8");
  return parse(source);
}

export function loadRatchetReference<T>(
  root: string,
  ref: string,
  baselinePath: string,
  parse: (source: string) => T,
) {
  const entry = readGitText(root, ["ls-tree", "--name-only", ref, "--", baselinePath]).trim();
  return entry === baselinePath
    ? parse(readGitText(root, ["show", ref + ":" + baselinePath]))
    : null;
}

export function loadRatchetSources(root: string, filePaths: string[], ref = "") {
  if (filePaths.length === 0) {
    return new Map<string, string>();
  }
  const output = execFileSync("git", ["cat-file", "--batch", "-z"], {
    cwd: root,
    input: filePaths.map((filePath) => ref + ":" + filePath).join("\0") + "\0",
    maxBuffer: GIT_MAX_BUFFER,
  });
  const sources = new Map<string, string>();
  let offset = 0;
  // `-z` frames requests only; each response still has a newline header and payload terminator.
  for (const filePath of filePaths) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) {
      throw new Error("Invalid git cat-file response for " + filePath);
    }
    // Missing responses echo the requested path, whose spaces/newlines can spoof a size.
    // Only a complete object header may frame source bytes.
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const size = Number(/^[0-9a-f]+ (?:blob|tree|commit|tag) (\d+)$/u.exec(header)?.[1]);
    if (!Number.isSafeInteger(size)) {
      throw new Error("Could not read " + (ref || "staged") + " source " + filePath);
    }
    const sourceStart = headerEnd + 1;
    const sourceEnd = sourceStart + size;
    if (output[sourceEnd] !== 10) {
      throw new Error("Invalid git cat-file framing for " + filePath);
    }
    sources.set(filePath, output.subarray(sourceStart, sourceEnd).toString("utf8"));
    offset = sourceEnd + 1;
  }
  return sources;
}

export function listRatchetRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  sourceRoots: string[],
) {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (staged) {
    args.push("--cached");
  }
  args.push(baseRef, "--", ...sourceRoots);
  const fields = execFileSync("git", args, { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString("utf8")
    .split("\0");
  const renames: { from: string; to: string }[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      break;
    }
    const from = fields[index++];
    if (!status.startsWith("R") && !status.startsWith("C")) {
      continue;
    }
    const to = fields[index++];
    if (status.startsWith("R") && from && to) {
      renames.push({ from, to });
    }
  }
  return renames;
}

export function parseRatchetPaths(source: string) {
  return new Set(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export function parseRatchetCounts(source: string, baselinePath: string) {
  const counts = new Map<string, number>();
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine === "" || rawLine.startsWith("#")) {
      continue;
    }
    const separator = rawLine.lastIndexOf("\t");
    const entry = rawLine.slice(0, separator);
    const count = Number(rawLine.slice(separator + 1));
    if (separator <= 0 || !Number.isSafeInteger(count) || count <= 0 || counts.has(entry)) {
      throw new Error(`Invalid ${baselinePath} entry: ${rawLine}`);
    }
    counts.set(entry, count);
  }
  return counts;
}

export function parseRatchetScalar(source: string, baselinePath: string) {
  const values = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const value = values[0];
  if (values.length !== 1 || value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`${baselinePath} must contain exactly one non-negative integer`);
  }
  return Number(value);
}

export function compareRatchetSets(
  current: Iterable<string>,
  allowed: ReadonlySet<string>,
  compare: (left: string, right: string) => number = compareEntries,
) {
  const currentSet = new Set(current);
  return {
    added: [...currentSet].filter((entry) => !allowed.has(entry)).toSorted(compare),
    removed: [...allowed].filter((entry) => !currentSet.has(entry)).toSorted(compare),
  };
}

export function compareRatchetCounts(
  current: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
) {
  return {
    increased: collectRatchetDeltas(current, allowed, true),
    decreased: collectRatchetDeltas(allowed, current, false),
  };
}

function collectRatchetDeltas(
  entries: ReadonlyMap<string, number>,
  counterpart: ReadonlyMap<string, number>,
  increased: boolean,
) {
  return [...entries]
    .flatMap(([entry, count]): RatchetCountDelta[] => {
      const other = counterpart.get(entry) ?? 0;
      return count > other
        ? [{ allowed: increased ? other : count, current: increased ? count : other, entry }]
        : [];
    })
    .toSorted((left, right) => compareEntries(left.entry, right.entry));
}

function formatRatchetMessage(title: string, entries: readonly string[]) {
  return [title, ...entries.map((entry) => "  " + entry)].join("\n");
}

export function reportRatchetFailures(
  groups: readonly { entries: readonly string[]; title: string }[],
  guidance?: string,
) {
  const active = groups.filter((group) => group.entries.length > 0);
  for (const group of active) {
    console.error(formatRatchetMessage(group.title, group.entries));
  }
  if (active.length > 0 && guidance) {
    console.error(guidance);
  }
  return active.length > 0;
}

type PerFileCountRatchetOptions = {
  baselinePath: string;
  baselineHeader: string;
  renameSourceRoots: string[];
  collectCurrent: (options: { staged: boolean }) => ReadonlyMap<string, number>;
  // Throws when the file is missing at ref.
  countAtRef: (ref: string, filePath: string) => number;
  messages: {
    increaseTitle: string;
    expansionTitle: string;
    guidance: string;
    countNoun: string;
    successTitle: string;
  };
};

function formatBaseline(counts: ReadonlyMap<string, number>, header: string) {
  const entries = [...counts]
    .filter(([, count]) => count > 0)
    .toSorted(([left], [right]) => compareEntries(left, right))
    .map(([filePath, count]) => `${filePath}\t${count}`);
  return header + entries.join("\n") + (entries.length > 0 ? "\n" : "");
}

function baselineWithVerifiedRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  baseline: ReadonlyMap<string, number>,
  baseBaseline: ReadonlyMap<string, number>,
  sourceRoots: string[],
) {
  const allowed = new Map(baseBaseline);
  for (const { from, to } of listRatchetRenames(root, baseRef, staged, sourceRoots)) {
    const oldCount = baseBaseline.get(from);
    const newCount = baseline.get(to);
    if (
      oldCount !== undefined &&
      newCount !== undefined &&
      newCount <= oldCount &&
      !baseline.has(from)
    ) {
      allowed.delete(from);
      allowed.set(to, oldCount);
    }
  }
  return allowed;
}

function allowanceWithExistingBaseCounts(
  baseRef: string,
  proposed: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
  countAtRef: PerFileCountRatchetOptions["countAtRef"],
) {
  const effective = new Map(allowed);
  for (const [filePath, count] of proposed) {
    if (count <= (effective.get(filePath) ?? 0)) {
      continue;
    }
    try {
      const baseCount = countAtRef(baseRef, filePath);
      if (baseCount > (effective.get(filePath) ?? 0)) {
        effective.set(filePath, baseCount);
      }
    } catch {
      // Missing base paths are branch additions and receive no allowance.
    }
  }
  return effective;
}

function formatDeltas(entries: RatchetCountDelta[], comparison: ">" | "<") {
  return entries.map((entry) => `${entry.entry}: ${entry.current} ${comparison} ${entry.allowed}`);
}

function totalCount(counts: ReadonlyMap<string, number>) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

export function runPerFileCountRatchet(
  root: string,
  argv: string[],
  options: PerFileCountRatchetOptions,
) {
  const { baselinePath, messages } = options;
  const parseBaseline = (source: string) => parseRatchetCounts(source, baselinePath);
  const writeBaseline = (counts: ReadonlyMap<string, number>) =>
    fs.writeFileSync(path.join(root, baselinePath), formatBaseline(counts, options.baselineHeader));
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }

    const baseRef = resolveRatchetBase(root, { base: args.base, staged: args.staged });
    const baseBaseline = baseRef
      ? loadRatchetReference(root, baseRef, baselinePath, parseBaseline)
      : null;
    const current = options.collectCurrent({ staged: args.staged });

    let baseline;
    try {
      baseline = loadRatchetSnapshot(root, baselinePath, args.staged, parseBaseline);
    } catch {
      if (args.prune && !args.staged && baseBaseline === null) {
        writeBaseline(current);
        console.log(
          `Initialized ${baselinePath}: ${current.size} files, ${totalCount(current)} ${messages.countNoun}.`,
        );
        return 0;
      }
      throw new Error("Missing " + baselinePath + (args.staged ? " in the index" : ""));
    }

    if (args.prune && !args.staged && baseBaseline === null) {
      writeBaseline(current);
      console.log(
        `Refreshed initial ${baselinePath}: ${current.size} files, ${totalCount(current)} ${messages.countNoun}.`,
      );
      return 0;
    }
    const allowedBaseline =
      baseRef && baseBaseline
        ? baselineWithVerifiedRenames(
            root,
            baseRef,
            args.staged,
            baseline,
            baseBaseline,
            options.renameSourceRoots,
          )
        : baseBaseline;
    const currentAllowance =
      baseRef && baseBaseline
        ? allowanceWithExistingBaseCounts(baseRef, current, baseline, options.countAtRef)
        : baseline;
    const expansionAllowance =
      baseRef && allowedBaseline
        ? allowanceWithExistingBaseCounts(baseRef, baseline, allowedBaseline, options.countAtRef)
        : allowedBaseline;
    const increases = compareRatchetCounts(current, currentAllowance).increased;
    const expanded = expansionAllowance
      ? compareRatchetCounts(baseline, expansionAllowance).increased
      : [];

    if (
      reportRatchetFailures(
        [
          {
            entries: formatDeltas(increases, ">"),
            title: messages.increaseTitle,
          },
          {
            entries: formatDeltas(expanded, ">"),
            title: messages.expansionTitle,
          },
        ],
        messages.guidance,
      )
    ) {
      return 1;
    }

    if (args.prune) {
      const oldFiles = baseline.size;
      const oldCount = totalCount(baseline);
      writeBaseline(current);
      console.log(
        `Pruned ${baselinePath}: ${oldFiles} -> ${current.size} files; ${oldCount} -> ${totalCount(current)} ${messages.countNoun}.`,
      );
      return 0;
    }

    const stale = compareRatchetCounts(current, baseline).decreased;
    if (
      reportRatchetFailures([
        {
          entries: formatDeltas(stale, "<"),
          title: `Shrink ${baselinePath} entries (or run with --prune):`,
        },
      ])
    ) {
      return 1;
    }

    console.log(
      `${messages.successTitle}: ${current.size} files, ${totalCount(current)} grandfathered ${messages.countNoun}.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
