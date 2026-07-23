#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];
export const DEFAULT_FORBIDDEN_PATHS = [
  "youtube-v1/local-output",
  "youtube-v1/.venv-youtube",
  "youtube-v1/.venv-youtube-3.12",
  "music-creator-v1/state/garageband-bridge-signing-key.pem",
  "music-creator-v1/state/garageband-bridge-signing-key.pub.pem",
];
export const EXPECTED_PUSH_REMOTE_ENV = "OPENCLAW_PUSH_REMOTE";
export const FORBIDDEN_PATH_CONFIG_KEY = "openclaw.pushPreflight.forbiddenPath";

function runGit(spawn, cwd, args) {
  const result = spawn("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? null,
    error: result.error,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function trimOutput(result) {
  return result.stdout.trim();
}

function readOptionalGit(git, args) {
  const result = git(args);
  if (!result.ok) {
    return null;
  }
  return trimOutput(result);
}

function readGitList(git, args) {
  const result = git(args);
  if (!result.ok) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function uniqueNonBlank(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function redactRemoteUrl(value) {
  if (!value) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "";
    }
    return url.toString();
  } catch {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1redacted@");
  }
}

function readRequiredGit(git, args, code, message, issues) {
  const result = git(args);
  if (!result.ok) {
    issues.push({
      code,
      severity: "error",
      message,
      detail: result.stderr.trim() || result.error?.message || `git ${args.join(" ")} failed`,
    });
    return null;
  }
  return trimOutput(result);
}

function addForbiddenPathIssues(git, issues, forbiddenPaths) {
  for (const path of forbiddenPaths) {
    const tracked = git(["ls-files", "--", path]);
    if (tracked.ok && tracked.stdout.trim()) {
      issues.push({
        code: "forbidden_tracked_path",
        severity: "error",
        message: `Tracked path is not safe to publish: ${path}`,
        detail: tracked.stdout.trim().split(/\r?\n/).slice(0, 5).join("\n"),
      });
    }

    const staged = git(["diff", "--name-only", "--cached", "--", path]);
    if (staged.ok && staged.stdout.trim()) {
      issues.push({
        code: "forbidden_staged_path",
        severity: "error",
        message: `Staged path is not safe to publish: ${path}`,
        detail: staged.stdout.trim().split(/\r?\n/).slice(0, 5).join("\n"),
      });
    }

    const unpublished = git(["rev-list", "--objects", "HEAD", "--not", "--remotes", "--", path]);
    if (unpublished.ok && unpublished.stdout.trim()) {
      issues.push({
        code: "forbidden_unpublished_history",
        severity: "error",
        message: `Unpublished history contains a path that must not be pushed: ${path}`,
        detail: unpublished.stdout.trim().split(/\r?\n/).slice(0, 5).join("\n"),
      });
    }
  }
}

export function evaluateGitPushPreflight(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const protectedBranches = params.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  const spawn = params.spawnSync ?? spawnSync;
  const env = params.env ?? process.env;
  const git = params.git ?? ((args) => runGit(spawn, cwd, args));
  const issues = [];

  const insideWorktree = readRequiredGit(
    git,
    ["rev-parse", "--is-inside-work-tree"],
    "not_git_worktree",
    "This command must run inside a Git worktree.",
    issues,
  );
  if (insideWorktree !== "true") {
    if (insideWorktree !== null) {
      issues.push({
        code: "not_git_worktree",
        severity: "error",
        message: "This command must run inside a Git worktree.",
      });
    }
    return { ok: false, issues, facts: {} };
  }

  const branch = readOptionalGit(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) {
    issues.push({
      code: "detached_head",
      severity: "error",
      message: "Current HEAD is detached. Create a codex/* topic branch before pushing.",
    });
  } else if (protectedBranches.includes(branch)) {
    issues.push({
      code: "protected_branch",
      severity: "error",
      message: `Current branch '${branch}' is protected. Create a codex/* topic branch from origin/main.`,
    });
  } else if (!branch.startsWith("codex/")) {
    issues.push({
      code: "non_codex_branch",
      severity: "warning",
      message: `Current branch '${branch}' does not use the expected codex/* prefix.`,
    });
  }

  const branchPushRemote = branch
    ? readOptionalGit(git, ["config", "--get", `branch.${branch}.pushRemote`])
    : null;
  const pushDefaultRemote = readOptionalGit(git, ["config", "--get", "remote.pushDefault"]);
  const branchRemote = branch
    ? readOptionalGit(git, ["config", "--get", `branch.${branch}.remote`])
    : null;
  const effectivePushRemote = branchPushRemote || pushDefaultRemote || branchRemote || null;
  const expectedPushRemote = firstNonBlank(
    params.expectedPushRemote,
    env[EXPECTED_PUSH_REMOTE_ENV],
    pushDefaultRemote,
  );

  if (expectedPushRemote && effectivePushRemote !== expectedPushRemote) {
    issues.push({
      code: "unexpected_push_remote",
      severity: "error",
      message: `Effective push remote is '${effectivePushRemote ?? "<none>"}', expected '${expectedPushRemote}'.`,
      detail: "Set remote.pushDefault or branch.<name>.pushRemote before pushing.",
    });
  }

  if (effectivePushRemote === "origin") {
    issues.push({
      code: "origin_push_remote",
      severity: "error",
      message: "Effective push remote is upstream 'origin'. Push to a fork topic branch instead.",
    });
  }

  const effectivePushRemoteUrl = effectivePushRemote
    ? readOptionalGit(git, ["remote", "get-url", "--push", effectivePushRemote])
    : null;
  const redactedEffectivePushRemoteUrl = redactRemoteUrl(effectivePushRemoteUrl);
  if (
    effectivePushRemoteUrl &&
    /github\.com[:/]openclaw\/openclaw(?:\.git)?$/i.test(effectivePushRemoteUrl)
  ) {
    issues.push({
      code: "upstream_push_url",
      severity: "error",
      message: `Push URL targets upstream OpenClaw repository: ${redactedEffectivePushRemoteUrl}`,
    });
  }

  const pushDefault = readOptionalGit(git, ["config", "--get", "push.default"]);
  if (pushDefault !== "current") {
    issues.push({
      code: "unexpected_push_default",
      severity: "error",
      message: `push.default is '${pushDefault ?? "<unset>"}', expected 'current'.`,
      detail:
        "Use push.default=current so a topic branch pushes to the same branch name on the fork.",
    });
  }

  const autoSetupRemote = readOptionalGit(git, ["config", "--get", "push.autoSetupRemote"]);
  if (autoSetupRemote !== "true") {
    issues.push({
      code: "auto_setup_remote_disabled",
      severity: "warning",
      message: `push.autoSetupRemote is '${autoSetupRemote ?? "<unset>"}'; new branches may need explicit -u.`,
    });
  }

  const upstream = readOptionalGit(git, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (upstream && upstream.startsWith("origin/") && effectivePushRemote === expectedPushRemote) {
    issues.push({
      code: "origin_tracking_branch",
      severity: "warning",
      message: `Branch tracks '${upstream}', but pushes are configured for '${expectedPushRemote}'.`,
      detail:
        "This is acceptable for PR branches based on origin/main; verify the branch name before pushing.",
    });
  }

  const configuredForbiddenPaths = readGitList(git, [
    "config",
    "--get-all",
    FORBIDDEN_PATH_CONFIG_KEY,
  ]);
  const forbiddenPaths = uniqueNonBlank([
    ...(params.forbiddenPaths ?? DEFAULT_FORBIDDEN_PATHS),
    ...configuredForbiddenPaths,
  ]);
  addForbiddenPathIssues(git, issues, forbiddenPaths);

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    facts: {
      branch,
      upstream,
      branchRemote,
      branchPushRemote,
      pushDefaultRemote,
      expectedPushRemote,
      effectivePushRemote,
      effectivePushRemoteUrl: redactedEffectivePushRemoteUrl,
      pushDefault,
      autoSetupRemote,
      forbiddenPaths,
    },
  };
}

function parseArgs(argv) {
  const options = {
    json: false,
    expectedPushRemote: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--expected-push-remote") {
      index += 1;
      if (!argv[index]) {
        throw new Error("--expected-push-remote requires a value");
      }
      options.expectedPushRemote = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function formatHuman(result) {
  const lines = [];
  lines.push(`OpenClaw Git push preflight: ${result.ok ? "PASS" : "FAIL"}`);
  if (result.facts.branch) {
    lines.push(`branch: ${result.facts.branch}`);
  }
  if (result.facts.effectivePushRemote) {
    lines.push(`push remote: ${result.facts.effectivePushRemote}`);
  }
  if (result.facts.effectivePushRemoteUrl) {
    lines.push(`push url: ${result.facts.effectivePushRemoteUrl}`);
  }
  for (const issue of result.issues) {
    lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    if (issue.detail) {
      lines.push(`  ${issue.detail.replace(/\r?\n/g, "\n  ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = evaluateGitPushPreflight({
      expectedPushRemote: options.expectedPushRemote,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatHuman(result));
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
