// Native owner proof (macOS/APFS):
// node --import ./scripts/tsx.mjs scripts/perf/worktree-prompt-native-measure.ts --root .local/prompt-native --setup
// node --import ./scripts/tsx.mjs scripts/perf/worktree-prompt-native-measure.ts --root .local/prompt-native [--base-file <saved-checkout.ts>]
// Counterbalance five pairs: real Git/APFS/index work, fresh destinations, one
// owned 3,000-file template. One adapter skips template database acquisition and
// validation. Readiness includes the same prompt read/hash; completion waits for
// index work. CPU excludes Git/clone children. Synthetic harness owns allocation.
// Caller sizing/admission callbacks are fixed; hydration and reservations are excluded.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    setup: { type: "boolean" },
    "base-file": { type: "string" },
  },
});
assert(values.root, "--root must be a task-owned fixture directory");
const root = path.resolve(values.root);
const repo = path.join(root, "repo");
const template = path.join(root, "template");
Object.assign(process.env, {
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_HOME: root,
  TMPDIR: path.join(root, "tmp"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const hash = async (file: string | URL) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
if (values.setup) {
  await fs.mkdir(root);
  await fs.mkdir(repo);
  await fs.mkdir(process.env.TMPDIR!);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "OpenClaw Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  const files = Array.from({ length: 3000 }, (_, i) => `dir-${Math.floor(i / 100)}/file-${i}.txt`);
  for (const name of files) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), "x".repeat(256));
  }
  await fs.writeFile(path.join(repo, "AGENTS.md"), "Synthetic prompt\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "synthetic fixture");
  git(repo, "worktree", "add", "--detach", template, "HEAD");
  for (const name of [...files, "AGENTS.md"]) {
    await fs.utimes(path.join(template, name), 1_600_000_000, 1_600_000_000);
  }
  git(template, "update-index", "--refresh");
  await fs.writeFile(
    path.join(root, "fixture.json"),
    JSON.stringify({ commit: git(repo, "rev-parse", "HEAD"), files: 3001 }),
  );
  console.log(JSON.stringify({ setup: root, files: 3001 }));
} else {
  const fixture = JSON.parse(await fs.readFile(path.join(root, "fixture.json"), "utf8")) as {
    commit: string;
    files: number;
  };
  assert.equal(git(repo, "rev-parse", "HEAD"), fixture.commit);
  const ownerUrl = new URL("../../src/agents/worktrees/checkout.ts", import.meta.url).href;
  const templateUrl = new URL("../../src/agents/worktrees/template-cache.ts", import.meta.url).href;
  const baseUrl = values["base-file"]
    ? pathToFileURL(path.resolve(values["base-file"])).href
    : undefined;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      return url === templateUrl
        ? {
            format: "module",
            shortCircuit: true,
            source: `export const prepareWorktreeTemplate=async options=>({path:${JSON.stringify(template)},sourceCommit:${JSON.stringify(fixture.commit)},contentKey:options.contentKey,release:async()=>{}});`,
          }
        : nextLoad(url === ownerUrl && baseUrl ? baseUrl : url, context);
    },
  });
  try {
    const { addManagedWorktree } = await import("../../src/agents/worktrees/checkout.js");
    const name = `measure-${randomUUID()}`;
    const destination = path.join(root, name);
    const promptHash = await hash(path.join(template, "AGENTS.md"));
    let readyAt: number | undefined;
    const ready = async (commit: string) => {
      assert.equal(commit, fixture.commit);
      assert.equal(await hash(path.join(destination, "AGENTS.md")), promptHash);
      assert.equal(readyAt, undefined);
      readyAt = performance.now();
    };
    const loadBefore = loadavg();
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    const result = await addManagedWorktree({
      env: process.env,
      now: Date.now,
      enabled: true,
      repoRoot: repo,
      commonDir: path.join(repo, ".git"),
      worktreeRoot: root,
      destination,
      base: fixture.commit,
      branch: name,
      commitGuard: () => {},
      requireSpace: async () => {},
      onPromptReady: ready,
      prepareCommit: async () => fixture.files * 4096,
    });
    const completedAt = performance.now();
    if (readyAt === undefined) {
      await ready(fixture.commit);
    }
    const cpu = process.cpuUsage(cpuStart);
    assert.equal(result.code, 0);
    assert.equal(result.templateCloned, true);
    assert.equal(git(destination, "status", "--porcelain"), "");
    console.log(
      JSON.stringify({
        arm: baseUrl ? "base" : "candidate",
        files: fixture.files,
        root,
        destination,
        readyMs: readyAt! - startedAt,
        completeMs: completedAt - startedAt,
        overlapMs: Math.max(0, completedAt - readyAt!),
        processCpuMs: (cpu.user + cpu.system) / 1000,
        loadBefore,
        loadAfter: loadavg(),
        ownerSha256: await hash(new URL(baseUrl ?? ownerUrl)),
      }),
    );
  } finally {
    hooks.deregister();
    const { drainGlobalSingletonLifecycleState } =
      await import("../../src/shared/global-singleton.js");
    await drainGlobalSingletonLifecycleState();
  }
}
