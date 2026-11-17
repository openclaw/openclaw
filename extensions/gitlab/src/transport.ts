import fs from "node:fs/promises";
import path from "node:path";
import {
  configureProjectCheckoutMaintenance,
  executeGitCommand,
  projectCheckoutGitEnvironment,
  requireGitCommandOutput,
  runProjectGitCommand,
} from "openclaw/plugin-sdk/process-runtime";
import type {
  ManagedProjectSourceV1,
  ManagedProjectTransportOptions,
} from "openclaw/plugin-sdk/repository-sources";

const GIT_TIMEOUT_MS = 10 * 60_000;
const COMMIT = /^[a-f0-9]{40}$/u;
const BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,255}$/u;

// Anonymous HTTPS only: no credential helpers, no other protocols, no prompts.
const TRANSPORT_CONFIG = [
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
];

async function git(
  cwd: string,
  args: string[],
  options: ManagedProjectTransportOptions,
  label: string,
): Promise<string> {
  const start = options.startRun ?? (async <T>(run: () => T) => await run());
  const env = {
    ...projectCheckoutGitEnvironment(options.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
  };
  const result = await start(() =>
    runProjectGitCommand(() =>
      executeGitCommand(cwd, [...TRANSPORT_CONFIG, ...args], {
        env,
        timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
        signal: options.signal,
        beforeRun: options.assertCurrent,
        killProcessTree: true,
      }),
    ),
  );
  options.assertCurrent();
  // Remote output can echo URLs; report the failed step, not the transport payload.
  return requireGitCommandOutput(
    label,
    result,
    () => new Error(`GitLab ${label} failed. Check that the repository is public and try again.`),
  ).trim();
}

async function hasCommit(target: string, commit: string, options: ManagedProjectTransportOptions) {
  try {
    return (await git(target, ["cat-file", "-t", commit], options, "commit lookup")) === "commit";
  } catch {
    return false;
  }
}

async function ensureCommit(
  input: { url: string; target: string; commit: string },
  options: ManagedProjectTransportOptions,
): Promise<void> {
  if (!COMMIT.test(input.commit)) {
    throw new Error("GitLab checkout requires an exact commit.");
  }
  if (await hasCommit(input.target, input.commit, options)) {
    return;
  }
  await git(
    input.target,
    ["fetch", "--quiet", "--no-tags", "--", input.url, input.commit],
    options,
    "commit fetch",
  );
  if (!(await hasCommit(input.target, input.commit, options))) {
    throw new Error("GitLab did not supply the pinned commit.");
  }
}

async function refresh(
  input: { url: string; target: string },
  options: ManagedProjectTransportOptions,
): Promise<void> {
  await git(
    input.target,
    [
      "fetch",
      "--quiet",
      "--prune",
      "--no-tags",
      "--",
      input.url,
      "+refs/heads/*:refs/remotes/origin/*",
    ],
    options,
    "refresh",
  );
}

async function remoteDefaultBranch(
  input: { url: string; target: string },
  options: ManagedProjectTransportOptions,
): Promise<string> {
  const output = await git(
    input.target,
    ["ls-remote", "--symref", "--", input.url, "HEAD"],
    options,
    "default branch lookup",
  );
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(output)?.[1];
  if (!branch || !BRANCH.test(branch)) {
    throw new Error("GitLab did not report a default branch for this repository.");
  }
  return branch;
}

async function resolveBase(
  input: { url: string; target: string; ref?: string },
  options: ManagedProjectTransportOptions,
): Promise<{ commit: string; ref: string }> {
  const requested = input.ref?.trim();
  if (requested && COMMIT.test(requested)) {
    await ensureCommit({ ...input, commit: requested }, options);
    return { commit: requested, ref: requested };
  }
  let remoteRef: string;
  if (requested) {
    const name = requested.replace(/^origin\//u, "");
    if (!BRANCH.test(name) || name.includes("..")) {
      throw new Error("Use a branch name, tag or commit for the GitLab base.");
    }
    // Clones skip tags, so ask GitLab whether the name is a branch or a tag.
    const listed = await git(
      input.target,
      ["ls-remote", "--", input.url, `refs/heads/${name}`, `refs/tags/${name}`],
      options,
      "base lookup",
    );
    const found = [`refs/heads/${name}`, `refs/tags/${name}`].find((candidate) =>
      listed.split("\n").some((line) => line.endsWith(`\t${candidate}`)),
    );
    if (!found) {
      throw new Error(
        "GitLab has no branch or tag with that name. Use a branch, tag or full commit.",
      );
    }
    remoteRef = found;
  } else {
    // Observe the current remote default, including a renamed default branch.
    remoteRef = `refs/heads/${await remoteDefaultBranch(input, options)}`;
  }
  const branch = remoteRef.startsWith("refs/heads/") ? remoteRef.slice("refs/heads/".length) : "";
  const localRef = branch ? `refs/remotes/origin/${branch}` : remoteRef;
  await git(
    input.target,
    ["fetch", "--quiet", "--no-tags", "--", input.url, `+${remoteRef}:${localRef}`],
    options,
    "base fetch",
  );
  const commit = await git(
    input.target,
    ["rev-parse", "--verify", "--end-of-options", `${localRef}^{commit}`],
    options,
    "base lookup",
  );
  return { commit, ref: branch ? `origin/${branch}` : localRef };
}

async function clone(
  input: { url: string; target: string; requiredCommit?: string },
  options: ManagedProjectTransportOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(input.target), { recursive: true });
  await git(
    path.dirname(input.target),
    ["clone", "--quiet", "--no-tags", "--", input.url, input.target],
    options,
    "clone",
  );
  await configureProjectCheckoutMaintenance(input.target, {
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    assertCurrent: options.assertCurrent,
    startRun: options.startRun,
  });
  if (input.requiredCommit) {
    await ensureCommit({ ...input, commit: input.requiredCommit }, options);
  }
}

/** Anonymous HTTPS transport for host-managed GitLab clones. */
export function createGitLabTransport(
  resolveUrl: ManagedProjectSourceV1["resolveUrl"],
): ManagedProjectSourceV1 {
  return {
    resolveUrl,
    invalidUrlMessage:
      "Use an HTTPS GitLab project URL on the configured server, such as https://gitlab.com/group/project.",
    clone,
    ensureCommit,
    refresh,
    resolveBase,
  };
}
