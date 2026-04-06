import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCKFILE_NAMES = ["pnpm-lock.yaml", "package-lock.json", "bun.lock", "bun.lockb"];
const SYNC_BRANCH_PREFIX = "sync/upstream-";
const VERIFY_COMMANDS = [
  ["pnpm", "install", "--frozen-lockfile"],
  ["pnpm", "build"],
  [
    "pnpm",
    "test",
    "src/cli/daemon-cli-compat.test.ts",
    "src/cli/live-cli.test.ts",
    "src/cli/live-control.test.ts",
  ],
  ["git", "diff", "--check"],
];

function writeLine(stream, value = "") {
  stream.write(`${value}\n`);
}

function formatDateStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    base: "main",
    dryRun: false,
    openPr: false,
    upstream: "upstream/main",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--open-pr") {
      options.openPr = true;
      continue;
    }
    if (arg === "--base") {
      options.base = argv[index + 1] ?? options.base;
      index += 1;
      continue;
    }
    if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length) || options.base;
      continue;
    }
    if (arg === "--upstream") {
      options.upstream = argv[index + 1] ?? options.upstream;
      index += 1;
      continue;
    }
    if (arg.startsWith("--upstream=")) {
      options.upstream = arg.slice("--upstream=".length) || options.upstream;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.base.trim()) {
    throw new Error("Base branch cannot be empty.");
  }
  if (!options.upstream.includes("/")) {
    throw new Error("Expected --upstream to look like <remote>/<branch>.");
  }
  return options;
}

function createExec(defaultCwd = process.cwd(), env = process.env) {
  return async function exec(argv, options = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd ?? defaultCwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          code,
          stderr,
          stdout,
        });
      });
    });
  };
}

function trimCommandFailure(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "unknown failure";
  }
  return value.split(/\r?\n/).slice(-6).join(" | ");
}

async function runCommand(exec, argv, options = {}) {
  const result = await exec(argv, options);
  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed: ${trimCommandFailure(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout.trim();
}

async function tryRunCommand(exec, argv, options = {}) {
  const result = await exec(argv, options).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function appendStepSummary(lines, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) {
    return;
  }
  await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
}

function formatCommitList(raw) {
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : ["none"];
}

function normalizeRepoSlug(remoteUrl) {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  if (sshMatch) {
    return sshMatch[1].replace(/^\/+/, "");
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.replace(/^\/+/, "");
  } catch {
    return trimmed.replace(/^\/+/, "");
  }
}

async function resolveOriginRepoSlug(exec, cwd) {
  const originUrl = await runCommand(exec, ["git", "remote", "get-url", "origin"], { cwd });
  const repoSlug = normalizeRepoSlug(originUrl);
  if (!repoSlug || !repoSlug.includes("/")) {
    throw new Error(`Could not determine the fork repository from origin remote: ${originUrl}`);
  }
  return repoSlug;
}

async function readExistingSyncPr(exec, repoSlug, baseBranch, cwd) {
  const raw = await runCommand(
    exec,
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repoSlug,
      "--base",
      baseBranch,
      "--state",
      "open",
      "--json",
      "number,url,headRefName,title,body,isCrossRepository",
    ],
    { cwd },
  );
  const prs = JSON.parse(raw);
  const matches = prs.filter(
    (pr) =>
      typeof pr.headRefName === "string" &&
      pr.headRefName.startsWith(SYNC_BRANCH_PREFIX) &&
      pr.isCrossRepository !== true,
  );
  if (matches.length > 1) {
    throw new Error(`Expected at most one open upstream sync PR, found ${matches.length}.`);
  }
  return matches[0] ?? null;
}

async function ensureBranchReady(params) {
  const { baseRef, branchName, cwd, exec, existingPr, upstreamRef } = params;
  if (existingPr) {
    await runCommand(exec, ["git", "fetch", "--quiet", "origin", branchName], { cwd });
    await runCommand(exec, ["git", "checkout", "-B", branchName, `origin/${branchName}`], { cwd });
    const mergeBase = await tryRunCommand(exec, ["git", "merge", "--no-edit", baseRef], { cwd });
    if (mergeBase === null) {
      await tryRunCommand(exec, ["git", "merge", "--abort"], { cwd });
      throw new Error(`Could not merge ${baseRef} into ${branchName}.`);
    }
  } else {
    await runCommand(exec, ["git", "checkout", "-B", branchName, baseRef], { cwd });
  }

  const mergeUpstream = await tryRunCommand(exec, ["git", "merge", "--no-edit", upstreamRef], {
    cwd,
  });
  if (mergeUpstream === null) {
    await tryRunCommand(exec, ["git", "merge", "--abort"], { cwd });
    throw new Error(`Could not merge ${upstreamRef} into ${branchName}.`);
  }
}

async function withTemporaryWorktree(exec, cwd, startRef, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-upstream-sync-"));
  let added = false;
  try {
    await runCommand(exec, ["git", "worktree", "add", "--quiet", "--detach", tempDir, startRef], {
      cwd,
    });
    added = true;
    return await fn(tempDir);
  } finally {
    if (added) {
      await tryRunCommand(exec, ["git", "worktree", "remove", "--force", tempDir], { cwd });
    }
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function previewSync(params) {
  const { baseRef, branchName, cwd, exec, existingPr, upstreamRef } = params;
  const startRef = existingPr ? `origin/${branchName}` : baseRef;
  if (existingPr) {
    await runCommand(exec, ["git", "fetch", "--quiet", "origin", branchName], { cwd });
  }
  return await withTemporaryWorktree(exec, cwd, startRef, async (worktreeCwd) => {
    if (existingPr) {
      const mergeBase = await tryRunCommand(exec, ["git", "merge", "--no-edit", baseRef], {
        cwd: worktreeCwd,
      });
      if (mergeBase === null) {
        await tryRunCommand(exec, ["git", "merge", "--abort"], { cwd: worktreeCwd });
        throw new Error(`Could not merge ${baseRef} into ${branchName}.`);
      }
    }

    const mergeUpstream = await tryRunCommand(exec, ["git", "merge", "--no-edit", upstreamRef], {
      cwd: worktreeCwd,
    });
    if (mergeUpstream === null) {
      await tryRunCommand(exec, ["git", "merge", "--abort"], { cwd: worktreeCwd });
      throw new Error(`Could not merge ${upstreamRef} into ${branchName}.`);
    }

    return await collectPrMetadata({
      baseRef,
      cwd: worktreeCwd,
      exec,
      targetRef: "HEAD",
      upstreamRef,
    });
  });
}

async function collectPrMetadata(params) {
  const { baseRef, cwd, exec, targetRef = "HEAD", upstreamRef } = params;
  const [baseSha, upstreamSha, branchSha, upstreamCommitsRaw, forkCommitsRaw, changedFilesRaw] =
    await Promise.all([
      runCommand(exec, ["git", "rev-parse", baseRef], { cwd }),
      runCommand(exec, ["git", "rev-parse", upstreamRef], { cwd }),
      runCommand(exec, ["git", "rev-parse", targetRef], { cwd }),
      runCommand(exec, ["git", "log", "--oneline", "--no-merges", `${baseRef}..${upstreamRef}`], {
        cwd,
      }),
      runCommand(exec, ["git", "log", "--oneline", "--no-merges", `${upstreamRef}..${targetRef}`], {
        cwd,
      }),
      runCommand(
        exec,
        [
          "git",
          "diff",
          "--name-only",
          `${baseRef}..${upstreamRef}`,
          "--",
          "package.json",
          ...LOCKFILE_NAMES,
        ],
        { cwd },
      ),
    ]);

  const changedFiles = changedFilesRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    baseSha,
    branchSha,
    forkOnlyCommits: formatCommitList(forkCommitsRaw),
    lockfileChanged: changedFiles.some((file) => LOCKFILE_NAMES.includes(file)),
    packageJsonChanged: changedFiles.includes("package.json"),
    upstreamCommits: formatCommitList(upstreamCommitsRaw),
    upstreamSha,
  };
}

function buildPrBody(params) {
  const { baseBranch, metadata, upstreamRef } = params;
  return [
    "## Summary",
    `- Base: \`origin/${baseBranch}\` @ \`${metadata.baseSha.slice(0, 7)}\``,
    `- Upstream: \`${upstreamRef}\` @ \`${metadata.upstreamSha.slice(0, 7)}\``,
    `- Sync branch head: \`${metadata.branchSha.slice(0, 7)}\``,
    `- package.json changed upstream: ${metadata.packageJsonChanged ? "yes" : "no"}`,
    `- lockfile changed upstream: ${metadata.lockfileChanged ? "yes" : "no"}`,
    "",
    "## Upstream Commits",
    ...metadata.upstreamCommits.map((entry) => `- ${entry}`),
    "",
    "## Fork-Only Commits Still Carried",
    ...metadata.forkOnlyCommits.map((entry) => `- ${entry}`),
    "",
    "## Verification",
    "- `pnpm install --frozen-lockfile`",
    "- `pnpm build`",
    "- `pnpm test src/cli/daemon-cli-compat.test.ts src/cli/live-cli.test.ts src/cli/live-control.test.ts`",
    "- `git diff --check`",
    "",
    "After this PR merges, apply it on the live machine with `openclaw live sync --apply`.",
    "",
  ].join("\n");
}

async function withTempFile(content, fn) {
  const filePath = path.join(
    os.tmpdir(),
    `openclaw-upstream-sync-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  await fs.writeFile(filePath, content, "utf8");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(filePath, { force: true });
  }
}

async function runVerification(exec, cwd, io) {
  for (const argv of VERIFY_COMMANDS) {
    writeLine(io.stdout, `$ ${argv.join(" ")}`);
    const result = await exec(argv, { cwd });
    if (result.code !== 0) {
      writeLine(io.stderr, result.stderr.trim() || result.stdout.trim());
      throw new Error(`Verification failed: ${argv.join(" ")}`);
    }
  }
}

export async function runUpstreamSync(argv = process.argv.slice(2), io, overrides = {}) {
  const streams = io ?? { stderr: process.stderr, stdout: process.stdout };
  const options = parseArgs(argv);
  const exec =
    overrides.exec ?? createExec(overrides.cwd ?? process.cwd(), overrides.env ?? process.env);
  const now = overrides.now ?? (() => new Date());
  const summaryLines = ["## Upstream Sync"];

  try {
    const cwd =
      overrides.cwd ??
      (await runCommand(exec, ["git", "rev-parse", "--show-toplevel"], {
        cwd: process.cwd(),
      }));
    const upstreamRef = options.upstream;
    const slashIndex = upstreamRef.indexOf("/");
    const upstreamRemote = upstreamRef.slice(0, slashIndex);
    const upstreamBranch = upstreamRef.slice(slashIndex + 1);
    const baseRef = `origin/${options.base}`;

    writeLine(
      streams.stdout,
      `Preparing fork sync from ${upstreamRef} into origin/${options.base}.`,
    );
    await runCommand(exec, ["git", "fetch", "--quiet", "origin", options.base], { cwd });
    await runCommand(exec, ["git", "fetch", "--quiet", upstreamRemote, upstreamBranch], { cwd });
    const repoSlug = await resolveOriginRepoSlug(exec, cwd);

    const upstreamAheadRaw = await runCommand(
      exec,
      ["git", "rev-list", "--count", `${baseRef}..${upstreamRef}`],
      { cwd },
    );
    const upstreamAhead = Number.parseInt(upstreamAheadRaw, 10);
    if (!Number.isFinite(upstreamAhead)) {
      throw new Error(`Unexpected upstream ahead count: ${upstreamAheadRaw}`);
    }
    summaryLines.push(`- Upstream commits ahead of origin/${options.base}: ${upstreamAhead}`);
    if (upstreamAhead === 0) {
      writeLine(streams.stdout, `No upstream commits ahead of origin/${options.base}.`);
      await appendStepSummary(summaryLines, overrides.env);
      return { action: "noop", branchName: null, exitCode: 0, prUrl: null };
    }

    const existingPr = options.openPr
      ? await readExistingSyncPr(exec, repoSlug, options.base, cwd)
      : null;
    const branchName = existingPr?.headRefName ?? `${SYNC_BRANCH_PREFIX}${formatDateStamp(now())}`;
    const metadata = options.dryRun
      ? await previewSync({
          baseRef,
          branchName,
          cwd,
          exec,
          existingPr,
          upstreamRef,
        })
      : await (async () => {
          await ensureBranchReady({
            baseRef,
            branchName,
            cwd,
            exec,
            existingPr,
            upstreamRef,
          });
          return await collectPrMetadata({
            baseRef,
            cwd,
            exec,
            targetRef: "HEAD",
            upstreamRef,
          });
        })();
    const prBody = buildPrBody({
      baseBranch: options.base,
      metadata,
      upstreamRef,
    });

    if (!options.dryRun) {
      await runVerification(exec, cwd, streams);
    } else {
      writeLine(
        streams.stdout,
        "Dry run enabled, previewed the sync in a temporary worktree and left the current checkout untouched.",
      );
    }

    let prUrl = existingPr?.url ?? null;
    let action = options.dryRun ? "prepared" : "verified";

    if (options.openPr && !options.dryRun) {
      await runCommand(exec, ["git", "push", "origin", `HEAD:${branchName}`], { cwd });
      const title = `chore: sync upstream main (${formatDateStamp(now())})`;
      prUrl = await withTempFile(prBody, async (bodyPath) => {
        if (existingPr) {
          await runCommand(
            exec,
            [
              "gh",
              "pr",
              "edit",
              String(existingPr.number),
              "--repo",
              repoSlug,
              "--title",
              title,
              "--body-file",
              bodyPath,
            ],
            { cwd },
          );
          action = "updated";
          return existingPr.url;
        }
        const created = await runCommand(
          exec,
          [
            "gh",
            "pr",
            "create",
            "--repo",
            repoSlug,
            "--base",
            options.base,
            "--head",
            branchName,
            "--title",
            title,
            "--body-file",
            bodyPath,
          ],
          { cwd },
        );
        action = "created";
        return created || null;
      });
    }

    summaryLines.push(`- Branch: \`${branchName}\``);
    summaryLines.push(
      `- package.json changed upstream: ${metadata.packageJsonChanged ? "yes" : "no"}`,
    );
    summaryLines.push(`- lockfile changed upstream: ${metadata.lockfileChanged ? "yes" : "no"}`);
    if (prUrl) {
      summaryLines.push(`- PR: ${prUrl}`);
    }
    await appendStepSummary(summaryLines, overrides.env);

    if (prUrl) {
      writeLine(streams.stdout, `Upstream sync PR ready: ${prUrl}`);
    } else {
      writeLine(streams.stdout, `Upstream sync branch ready: ${branchName}`);
    }
    return { action, branchName, exitCode: 0, prUrl };
  } catch (error) {
    writeLine(streams.stderr, String(error));
    summaryLines.push(`- Failure: ${String(error)}`);
    await appendStepSummary(summaryLines, overrides.env);
    return { action: "failed", branchName: null, exitCode: 1, prUrl: null };
  }
}

export async function main(argv = process.argv.slice(2), io, overrides = {}) {
  const result = await runUpstreamSync(argv, io, overrides);
  if (!io) {
    process.exitCode = result.exitCode;
  }
  return result.exitCode;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
