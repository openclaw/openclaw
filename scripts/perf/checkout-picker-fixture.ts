/**
 * Add a large synthetic Git checkout to an existing team-shape fixture (never live state).
 * Seed the state first with team-shape-fixture.ts --sessions 1000 --runs 0 --cron 0
 * --approvals 0 --projects 0 --transcript-mib 0, then run this script --root <fixture>.
 * Defaults: 62k tracked sparse files (1.1 GiB logical), 6k refs, 3k worktree registrations.
 * gateway-ui-rpc-measure.ts --picker-fixture <fixture> --picker-delay-ms 1000
 * delays each actual Git command equally in baseline/candidate without host-wide IO load.
 * Compare A/A controls then five alternating baseline/candidate runs; keep first/cold,
 * warm, and sampled-allocation passes separate. Acceptance: correct retained suggestions,
 * no request-bound Git wait, lower RPC p50/p95, and one refresh for concurrent callers.
 * The sparse contents and local filesystem do not reproduce btrfs page-read pressure.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    files: { type: "string", default: "62000" },
    refs: { type: "string", default: "6000" },
    worktrees: { type: "string", default: "3000" },
  },
});
assert(values.root);
const root = await fs.realpath(values.root);
const summary = JSON.parse(await fs.readFile(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
const count = (value: string) => {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n >= 0 && n <= 100000);
  return n;
};
const files = count(values.files),
  refs = count(values.refs),
  worktrees = count(values.worktrees);
const repo = path.join(root, "workspace");
await fs.mkdir(repo, { recursive: true });
assert(
  !(await fs.stat(path.join(repo, ".git")).catch(() => undefined)),
  "Synthetic checkout already exists",
);
const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};
const git = (args: string[], input?: string | Buffer) =>
  execFileSync(nativeGit, ["-C", repo, "-c", `core.hooksPath=${os.devNull}`, ...args], {
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
git(["init", "--template=", "-b", "main"]);
const fileBytes = 19051;
const blob = git(["hash-object", "-w", "--stdin"], Buffer.alloc(fileBytes));
let indexInput = "";
for (let index = 0; index < files; index++) {
  const name = `inventory/${Math.floor(index / 1000)}/${index}.txt`;
  if (index % 1000 === 0) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
  }
  const file = await fs.open(path.join(repo, name), "wx");
  await file.truncate(fileBytes);
  await file.close();
  indexInput += `100644 ${blob}\t${name}\n`;
}
git(["update-index", "--index-info"], indexInput);
const commit = git(["commit-tree", git(["write-tree"]), "-m", "synthetic picker fixture"]);
git(["update-ref", "refs/heads/main", commit]);
const packed = Array.from(
  { length: refs },
  (_, index) =>
    `${commit} refs/${index % 2 ? "remotes/origin" : "heads"}/branch-${String(index).padStart(5, "0")}`,
);
packed.push(`${commit} refs/remotes/origin/main`);
await fs.writeFile(path.join(repo, ".git", "packed-refs"), packed.toSorted().join("\n") + "\n");
git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
for (let index = 0; index < worktrees; index++) {
  const admin = path.join(repo, ".git", "worktrees", `synthetic-${index}`);
  await fs.mkdir(admin, { recursive: true });
  await fs.writeFile(path.join(admin, "HEAD"), commit + "\n");
  await fs.writeFile(path.join(admin, "commondir"), "../..\n");
  await fs.writeFile(
    path.join(admin, "gitdir"),
    path.join(root, "unmaterialized", String(index), ".git") + "\n",
  );
}
await fs.mkdir(path.join(root, "bin"));
await fs.writeFile(path.join(root, "git-delay-seconds"), "0\n");
await fs.writeFile(path.join(root, "git-calls.log"), "");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await fs.writeFile(
  path.join(root, "bin", "git"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(path.join(root, "git-calls.log"))}\ndelay=$(cat ${quote(path.join(root, "git-delay-seconds"))})\nif [ "$delay" != 0 ]; then sleep "$delay"; fi\nexec ${quote(nativeGit)} "$@"\n`,
  { mode: 0o700 },
);
const fixture = {
  format: "openclaw-checkout-picker-v1",
  files,
  logicalBytes: files * fileBytes,
  refs,
  worktrees,
  repository: repo,
};
await fs.writeFile(
  path.join(root, "checkout-picker.json"),
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log(JSON.stringify(fixture));
