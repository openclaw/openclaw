import { execFileSync } from "node:child_process";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  parseRatchetArgs,
  reportRatchetFailures,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

// A chat's address is its session key. These tokens pin one transcript or incarnation;
// production src may only use fewer of them over time.
const TOKENS = ["expectedSessionId", "expectedLifecycleRevision", ".lifecycleRevision"];
const PATHSPEC = [
  "src",
  ":(exclude,glob)**/*.test.ts",
  ":(exclude,glob)**/*.test-*.ts",
  ":(exclude,glob)**/*test-support*",
  ":(exclude,glob)**/*test-fixtures*",
  ":(exclude,glob)**/*test-helpers*",
  ":(exclude,glob)**/*test-utils*",
  ":(exclude,glob)**/*test-harness*",
  ":(exclude,glob)**/*.e2e.ts",
];

function countToken(root: string, token: string, ref: string | undefined) {
  try {
    const output = execFileSync(
      "git",
      [
        "grep",
        ...(ref ? [] : ["--cached"]),
        "-o",
        "-F",
        "-e",
        token,
        ...(ref ? [ref] : []),
        "--",
        ...PATHSPEC,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return output.split("\n").filter(Boolean).length;
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) {
      return 0;
    }
    throw error;
  }
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
    const entries: string[] = [];
    for (const token of TOKENS) {
      const before = countToken(root, token, base);
      const after = countToken(root, token, args.staged ? undefined : "HEAD");
      console.log(`Session identity ${token}: ${before} -> ${after}.`);
      if (after > before) {
        entries.push(`${token}: ${before} -> ${after}`);
      }
    }
    if (
      reportRatchetFailures(
        [{ title: `Session identity pins grew against ${base}`, entries }],
        "Address a chat by its session key. Only a live transcript writer may pin a session id or lifecycle revision; reuse an existing fence instead of adding one.",
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
