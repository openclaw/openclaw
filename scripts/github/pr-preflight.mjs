#!/usr/bin/env node
// Validate local PR title/body against OpenClaw's merge-prep expectations.
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { validatePullRequestDraft } from "./pr-preflight-policy.mjs";

const execFileAsync = promisify(execFile);

function isMainModule() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

function parseArgs(argv) {
  const options = {
    bodyFile: undefined,
    title: undefined,
    repo: undefined,
    pr: undefined,
    current: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--body-file") {
      options.bodyFile = argv[++index];
      continue;
    }
    if (arg === "--title") {
      options.title = argv[++index];
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[++index];
      continue;
    }
    if (arg === "--pr") {
      options.pr = argv[++index];
      continue;
    }
    if (arg === "--no-current") {
      options.current = false;
      continue;
    }
    if (arg === "--current") {
      options.current = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readBodyFromFile(bodyFile) {
  if (!bodyFile || bodyFile === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(bodyFile, "utf8");
}

async function readPullRequest(identifier, repo) {
  const args = ["pr", "view", identifier, "--json", "title,body,url,headRefName,baseRefName"];
  if (repo) {
    args.push("--repo", repo);
  }
  const { stdout } = await execFileAsync("gh", args, { encoding: "utf8" });
  return JSON.parse(stdout);
}

async function readCurrentBranch() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function readGitConfig(key) {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", key], {
      encoding: "utf8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseGitHubRepoSlug(url) {
  const match = String(url ?? "").match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+?)(?:\.git)?$/i);
  return match?.groups ? `${match.groups.owner}/${match.groups.repo}` : undefined;
}

async function readCurrentPullRequestNumber() {
  const { stdout } = await execFileAsync("gh", ["pr", "status"], { encoding: "utf8" });
  const currentBranchBlock = stdout.split(/Current branch\s*/iu)[1];
  if (!currentBranchBlock) {
    return undefined;
  }
  const numberMatch = currentBranchBlock.match(/#(?<number>\d+)\s/u);
  return numberMatch?.groups?.number;
}

async function readOpenPullRequestForCurrentBranch(repoOverride) {
  const currentNumber = await readCurrentPullRequestNumber();
  if (currentNumber) {
    return readPullRequest(currentNumber, repoOverride);
  }

  const branch = await readCurrentBranch();
  const upstreamRepo =
    repoOverride ?? (parseGitHubRepoSlug(await readGitConfig("remote.origin.url")) ?? undefined);
  const trackingRemote = await readGitConfig(`branch.${branch}.remote`);
  const headRemoteUrl =
    (trackingRemote ? await readGitConfig(`remote.${trackingRemote}.pushurl`) : undefined) ??
    (trackingRemote ? await readGitConfig(`remote.${trackingRemote}.url`) : undefined) ??
    (await readGitConfig("remote.fork.pushurl")) ??
    (await readGitConfig("remote.fork.url")) ??
    (await readGitConfig("remote.origin.pushurl")) ??
    (await readGitConfig("remote.origin.url"));
  const headRepoSlug = parseGitHubRepoSlug(headRemoteUrl);
  const headOwner = headRepoSlug?.split("/")[0];

  if (!upstreamRepo || !headOwner) {
    return readPullRequest(branch, repoOverride);
  }

  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      upstreamRepo,
      "--head",
      `${headOwner}:${branch}`,
      "--state",
      "open",
      "--json",
      "title,body,url,headRefName,baseRefName,number",
    ],
    { encoding: "utf8" },
  );
  const pullRequests = JSON.parse(stdout);
  const current = Array.isArray(pullRequests) ? pullRequests[0] : undefined;
  if (current) {
    return current;
  }

  return readPullRequest(branch, repoOverride ?? upstreamRepo);
}

function printHelp() {
  console.log(`Usage:
  node scripts/github/pr-preflight.mjs [--title <title>] [--body-file <path>|-] [--repo <owner/repo>] [--pr <number|url|branch>] [--no-current]

Checks that a PR is shaped like a merge-ready OpenClaw contribution.
Default mode reads the current PR via \`gh pr view\`.
`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  let title = options.title;
  let body = "";

  if (options.current) {
    const current = options.pr
      ? await readPullRequest(options.pr, options.repo)
      : await readOpenPullRequestForCurrentBranch(options.repo);
    title ??= current.title ?? "";
    body = current.body ?? "";
  } else if (options.bodyFile) {
    body = readBodyFromFile(options.bodyFile);
  }

  if (!title) {
    throw new Error("No PR title available. Pass --title or use --current.");
  }

  const result = validatePullRequestDraft({ title, body });
  if (result.errors.length > 0) {
    console.error("PR preflight failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    if (result.warnings.length > 0) {
      console.error("Warnings:");
      for (const warning of result.warnings) {
        console.error(`- ${warning}`);
      }
    }
    return 1;
  }

  console.log("PR preflight passed.");
  for (const warning of result.warnings) {
    console.log(`Warning: ${warning}`);
  }
  return 0;
}

if (isMainModule()) {
  const exitCode = await main();
  process.exitCode = exitCode;
}

export { main };
