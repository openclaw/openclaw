import { execFileSync } from "node:child_process";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runPerFileCountRatchet } from "./lib/shrink-ratchet.mts";

// Nothing is stopped by inference. A chat is addressed by its key (ChatRef); a transcript id,
// lifecycle revision, run id, generation or leaf id names one attempt and lives only in a
// TranscriptLease or a view precondition inside the session store. Outside it, no file may
// compare those values, name a pin, or refuse with a "something changed" message. Existing hits
// are listed in the allowlist, which may only shrink.
const BASELINE_PATH = "config/session-identity-allowlist.txt";
const BASELINE_HEADER = [
  "# Identity class A: per-file counts of id compares, pin names and inference refusals.",
  "# Ratchet: counts may only shrink. Address chats by ChatRef; fence writers by TranscriptLease.",
  "# Format: repo-relative path, tab, positive count. Zero-count files are omitted.",
  "",
].join("\n");
const ROOTS = ["src", "extensions"];
const OWNER = /^src\/config\/sessions\//u;
const ID = String.raw`(?:\w*[sS]essionId|lifecycleRevision|\w*[rR]unId|generation|\w*[lL]eafEntryId)`;
const PATTERNS = [
  /\bexpected(?:SessionId|LifecycleRevision)\b/gu,
  new RegExp(String.raw`(?:^|[^\w$])${ID}\s*[!=]==`, "gu"),
  new RegExp(String.raw`[!=]==\s*[\w$.?()[\]]*(?:^|[^\w$])${ID}\b`, "gu"),
  /differs from the captured|no longer active|changed before|was replaced/giu,
];
const TOKENS = [
  "essionId",
  "ifecycleRevision",
  "unId",
  "generation",
  "eafEntryId",
  "differs from the captured",
  "no longer active",
  "changed before",
  "was replaced",
];
const EXCLUDE = [
  "*.test.ts",
  "*.test-*.ts",
  "*test-support*",
  "*test-fixtures*",
  "*test-helpers*",
  "*test-utils*",
  "*test-harness*",
  "*.e2e.ts",
].map((glob) => `:(exclude,glob)**/${glob}`);

/** Counts each pin name, id compare and inference refusal on one line. */
export function countSessionIdentityPins(line: string) {
  return PATTERNS.reduce((sum, pattern) => sum + (line.match(pattern)?.length ?? 0), 0);
}

function countSource(source: string) {
  return source.split("\n").reduce((sum, line) => sum + countSessionIdentityPins(line), 0);
}

function collectCurrent(root: string, staged: boolean) {
  let output = "";
  try {
    output = execFileSync(
      "git",
      [
        "grep",
        "-I",
        "-i",
        ...(staged ? ["--cached"] : []),
        "-F",
        ...TOKENS.flatMap((token) => ["-e", token]),
        "--",
        ...ROOTS.map((sourceRoot) => `${sourceRoot}/**/*.ts`),
        ...EXCLUDE,
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
    const separator = row.indexOf(":");
    const file = row.slice(0, separator);
    if (separator <= 0 || OWNER.test(file)) {
      continue;
    }
    const found = countSessionIdentityPins(row.slice(separator + 1));
    if (found > 0) {
      counts.set(file, (counts.get(file) ?? 0) + found);
    }
  }
  return counts;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  return runPerFileCountRatchet(root, argv, {
    baselinePath: BASELINE_PATH,
    baselineHeader: BASELINE_HEADER,
    renameSourceRoots: ROOTS,
    collectCurrent: ({ staged }) => collectCurrent(root, staged),
    countAtRef: (ref, filePath) =>
      OWNER.test(filePath)
        ? 0
        : countSource(
            execFileSync("git", ["show", `${ref}:${filePath}`], {
              cwd: root,
              encoding: "utf8",
              maxBuffer: 256 * 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"],
            }),
          ),
    messages: {
      increaseTitle: "Session identity pins exceed the per-file allowlist:",
      expansionTitle: "The session identity allowlist may only shrink:",
      guidance:
        "Address a chat by its key (ChatRef). Only a live writer holds a transcript, through TranscriptLease, and a view precondition uses the prefix rule. Do not compare session ids, lifecycle revisions, run ids, generations or leaf ids, and do not refuse with a 'changed'/'replaced'/'no longer active' message.",
      countNoun: "pins",
      successTitle: "Session identity ratchet OK",
    },
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
