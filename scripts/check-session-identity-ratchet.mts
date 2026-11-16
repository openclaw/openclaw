import { execFileSync } from "node:child_process";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  listRatchetRenames,
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

// A chat's address is its session key. A transcript id or lifecycle revision names one
// transcript, so only the session store and the transcript lease may compare or pin one.
// Elsewhere no file may add a pin name or an id compare.
const ROOTS = ["src", "extensions"];
const OWNER = /^src\/config\/sessions\//u;
const NAMES = /\bexpected(?:SessionId|LifecycleRevision)\b/gu;
const COMPARES = [
  /\.(?:sessionId|lifecycleRevision)\s*[!=]==/gu,
  /[!=]==\s*[\w$.?()[\]]*\.(?:sessionId|lifecycleRevision)\b/gu,
];
const PATHSPEC = [
  ...ROOTS,
  ":(exclude,glob)**/*.test.ts",
  ":(exclude,glob)**/*.test-*.ts",
  ":(exclude,glob)**/*test-support*",
  ":(exclude,glob)**/*test-fixtures*",
  ":(exclude,glob)**/*test-helpers*",
  ":(exclude,glob)**/*test-utils*",
  ":(exclude,glob)**/*test-harness*",
  ":(exclude,glob)**/*.e2e.ts",
];

/** Counts each line once per pin name and once per id compare. */
export function countSessionIdentityPins(line: string) {
  return (
    (line.match(NAMES)?.length ?? 0) +
    COMPARES.reduce((sum, pattern) => sum + (line.match(pattern)?.length ?? 0), 0)
  );
}

function countFiles(root: string, ref: string | undefined) {
  let output = "";
  try {
    output = execFileSync(
      "git",
      [
        "grep",
        "-I",
        ...(ref ? [] : ["--cached"]),
        "-F",
        ...["sessionId", "SessionId", "lifecycleRevision", "LifecycleRevision"].flatMap((token) => [
          "-e",
          token,
        ]),
        ...(ref ? [ref] : []),
        "--",
        ...PATHSPEC,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) {
      throw error;
    }
  }
  const counts = new Map<string, number>();
  for (const row of output.split("\n")) {
    const withoutRef = ref ? row.slice(ref.length + 1) : row;
    const separator = withoutRef.indexOf(":");
    const file = withoutRef.slice(0, separator);
    if (separator <= 0 || OWNER.test(file)) {
      continue;
    }
    const found = countSessionIdentityPins(withoutRef.slice(separator + 1));
    if (found > 0) {
      counts.set(file, (counts.get(file) ?? 0) + found);
    }
  }
  return counts;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("Session identity ratchet has no baseline to prune.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("Session identity ratchet requires a Git base commit.");
    }
    const before = countFiles(root, base);
    for (const { from, to } of listRatchetRenames(root, base, args.staged, ROOTS)) {
      before.set(to, (before.get(to) ?? 0) + (before.get(from) ?? 0));
    }
    const after = countFiles(root, args.staged ? undefined : "HEAD");
    const sum = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(
      `Session identity pins outside the session store: ${sum(before)} -> ${sum(after)}.`,
    );
    const entries = [...after]
      .filter(([file, count]) => count > (before.get(file) ?? 0))
      .map(([file, count]) => `${file}: ${before.get(file) ?? 0} -> ${count}`)
      .toSorted();
    if (
      reportRatchetFailures(
        [{ title: `Session identity pins grew against ${base}`, entries }],
        "Address a chat by its key (ChatRef). Only a live writer holds a transcript, through TranscriptLease; do not compare sessionId or lifecycleRevision, and do not add expectedSessionId or expectedLifecycleRevision.",
      )
    ) {
      return 1;
    }
    console.log(`Session identity ratchet OK against ${base}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
