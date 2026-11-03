import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureProjectCheckoutMaintenance,
  PROJECT_MAINTENANCE_CONFIG,
  projectCheckoutGitEnvironment,
  runProjectGitCommand,
  ProjectCloneError,
  hasErrnoCode,
  executeGitCommand,
  requireGitCommandOutput,
  withGitNetworkRetry,
  withGitRepositoryRepair,
  hasCommandProcessCleanupError,
  runCommandWithTimeout,
  withGitProcessOperation,
  type GitCommandOptions,
  type GitOperationStarter,
} from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export { ProjectCloneError, configureProjectCheckoutMaintenance };

const PROJECT_CLONE_TIMEOUT_MS = 10 * 60_000;
type ProjectCloneOptions = {
  assertCurrent?: () => void;
  startRun?: GitOperationStarter;
  env?: NodeJS.ProcessEnv;
  objectDirectory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  token?: string;
};
const PROJECT_FETCH_TIMEOUT_MS = 60_000;
const PROJECT_REF_INVENTORY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
function cloneCommandEnv(
  repositoryUrl: string | undefined,
  token: string | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const gitEnv = projectCheckoutGitEnvironment(env);
  if (token && repositoryUrl) {
    const origin = new URL(repositoryUrl).origin;
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = `http.${origin}/.extraHeader`;
    gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return gitEnv;
}

function classifyProjectGitFailure(
  result: Awaited<ReturnType<typeof runCommandWithTimeout>>,
  operation: "clone" | "fetch",
  tokenConfigured: boolean,
): ProjectCloneError {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    result.termination === "timeout" ||
    result.termination === "no-output-timeout" ||
    /could not resolve host|connection timed out|failed to connect/u.test(detail)
  ) {
    return new ProjectCloneError(
      "network",
      `Git ${operation} could not reach GitHub. Check the Gateway network connection and retry.`,
    );
  }
  if (
    /authentication failed|permission denied|could not read username|access denied/u.test(detail)
  ) {
    return new ProjectCloneError(
      "auth_required",
      tokenConfigured
        ? "GitHub rejected the active Control UI credential. Update plugins.entries.github-repositories.config.service.token when set; otherwise update the shared Gateway process environment, then retry."
        : "GitHub authentication is required. Configure plugins.entries.github-repositories.config.service.token or set GH_TOKEN/GITHUB_TOKEN in the shared Gateway process environment to clone private repositories.",
    );
  }
  if (/repository not found|not found/u.test(detail)) {
    return tokenConfigured
      ? new ProjectCloneError(
          "not_found",
          "GitHub could not find that repository. Check the URL and repository access.",
        )
      : new ProjectCloneError(
          "auth_required",
          "The repository was not found or is private. Check the URL, or configure plugins.entries.github-repositories.config.service.token (or the shared Gateway process environment) for private repositories.",
        );
  }
  return new ProjectCloneError(
    "clone_failed",
    `Git could not ${operation === "clone" ? "clone" : "refresh"} that repository. Check the URL and Gateway Git configuration, then retry.`,
  );
}

/** Clones one already-validated source into an unoccupied managed target. */
export async function cloneProjectCheckout(
  input: { url: string; target: string; requiredCommit?: string },
  options: ProjectCloneOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const existed = await fs.lstat(input.target).then(
    () => true,
    (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw new ProjectCloneError(
        "clone_failed",
        "The managed checkout target could not be inspected. Check Gateway filesystem access and retry.",
      );
    },
  );
  if (existed) {
    throw new ProjectCloneError(
      "target_exists",
      "A managed checkout already exists for this repository. Register or remove it before retrying.",
    );
  }
  await fs.mkdir(path.dirname(input.target), { recursive: true });
  const commandEnv = cloneCommandEnv(input.url, options.token, env);
  const result = await withGitNetworkRetry(
    "clone",
    {
      timeoutMs: options.timeoutMs ?? PROJECT_CLONE_TIMEOUT_MS,
      signal: options.signal,
      beforeRun: options.assertCurrent,
      startRun: options.startRun,
    },
    async (timeoutMs) => {
      const attempt = await runProjectGitCommand(() =>
        withGitProcessOperation("project.clone", () =>
          runCommandWithTimeout(
            [
              "git",
              "clone",
              ...PROJECT_MAINTENANCE_CONFIG.flatMap(([key, value]) => [
                "--config",
                `${key}=${value}`,
              ]),
              "--no-recurse-submodules",
              "--",
              input.url,
              input.target,
            ],
            {
              env: commandEnv,
              timeoutMs,
              signal: options.signal,
              killProcessTree: true,
              maxOutputBytes: 256 * 1024,
            },
          ),
        ),
      );
      if (attempt.code !== 0 || attempt.termination !== "exit") {
        await fs.rm(input.target, { recursive: true, force: true }).catch(() => {
          throw new ProjectCloneError(
            "clone_failed",
            "Git could not remove the incomplete checkout. Check Gateway filesystem access and remove the partial checkout before retrying.",
          );
        });
      }
      return attempt;
    },
  );
  if (result.code === 0 && result.termination === "exit") {
    if (input.requiredCommit) {
      try {
        await ensureProjectCheckoutCommit({ ...input, commit: input.requiredCommit }, options);
      } catch (error) {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        await fs.rm(input.target, { recursive: true, force: true });
        throw error;
      }
    }
    return;
  }
  throw classifyProjectGitFailure(result, "clone", Boolean(options.token));
}

/** Refreshes refs in an existing Gateway-managed project checkout. */
export async function refreshProjectCheckout(
  input: { target: string; url: string },
  options: ProjectCloneOptions = {},
): Promise<void> {
  const [objectPath, objectFormatResult, initialRefs, filterResult] = await Promise.all([
    runProjectCheckoutGit(input, options, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]),
    runProjectCheckoutGit(input, options, ["rev-parse", "--show-object-format"]),
    readProjectRemoteRefs(input, options),
    runProjectCheckoutGit(input, options, ["config", "--get", "remote.origin.partialclonefilter"]),
  ]);
  // The temporary repository does not inherit the managed clone's origin filter.
  const filter =
    filterResult.code === 1 && filterResult.termination === "exit"
      ? ""
      : requireGitCommandOutput("git config remote.origin.partialclonefilter", filterResult).trim();
  let currentRefs = initialRefs;
  if (objectPath.code !== 0 || objectPath.termination !== "exit") {
    throw new ProjectCloneError(
      "clone_failed",
      "The managed repository object store could not be verified. Remove the repository and retry.",
    );
  }
  const objectFormat = objectFormatResult.stdout.trim();
  if (
    objectFormatResult.code !== 0 ||
    objectFormatResult.termination !== "exit" ||
    (objectFormat !== "sha1" && objectFormat !== "sha256")
  ) {
    throw new ProjectCloneError(
      "clone_failed",
      "The managed repository object format could not be verified. Remove the repository and retry.",
    );
  }
  const objects = await fs.realpath(objectPath.stdout.trim());
  const staging = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-project-fetch-"),
  );
  let retainStaging = false;
  try {
    const initialized = await runProjectCheckoutGit({ target: staging }, options, [
      "init",
      "--bare",
      `--object-format=${objectFormat}`,
    ]);
    if (initialized.code !== 0 || initialized.termination !== "exit") {
      throw new ProjectCloneError(
        "clone_failed",
        "Git could not prepare a safe repository refresh. Retry the session.",
      );
    }
    const stagingOptions = { ...options, objectDirectory: objects };
    let protectedRefs: ReadonlySet<string> | undefined;
    if (currentRefs.size > 0) {
      // Seed only refs already owned by the managed checkout. Besides enabling
      // incremental negotiation, this keeps transport isolated from local branches.
      const seed = () =>
        runProjectCheckoutGit({ target: staging }, stagingOptions, ["update-ref", "--stdin"], {
          input: Array.from(currentRefs, ([ref, commit]) => `update ${ref} ${commit}\n`).join(""),
        });
      const seeded = await withGitRepositoryRepair({
        cwd: input.target,
        result: await seed(),
        remote: input.url,
        canonicalTracking: true,
        onRepaired: (refs) => {
          protectedRefs = refs;
        },
        signal: options.signal,
        assertCurrent: options.assertCurrent,
        run: (args, commandOptions) =>
          args.includes("fetch") || args.includes("ls-remote")
            ? runProjectCheckoutGit(
                { target: staging, url: input.url },
                stagingOptions,
                args,
                commandOptions,
              )
            : runProjectCheckoutGit(input, options, args, commandOptions),
        retry: async () => {
          currentRefs = await readProjectRemoteRefs(input, options);
          return seed();
        },
      });
      if (seeded.code !== 0 || seeded.termination !== "exit") {
        throw new ProjectCloneError(
          "clone_failed",
          "Git could not prepare the managed repository refs for refresh. Retry the session.",
        );
      }
    }
    // The isolated repository owns transport, but it borrows the managed object store.
    // It must not run maintenance using its incomplete temporary ref inventory.
    const result = await runProjectCheckoutGit(
      { target: staging, url: input.url },
      {
        ...stagingOptions,
        timeoutMs: options.timeoutMs ?? PROJECT_FETCH_TIMEOUT_MS,
      },
      [
        "fetch",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--prune",
        ...(filter ? [`--filter=${filter}`] : []),
        "--",
        input.url,
        "+refs/heads/*:refs/remotes/origin/*",
      ],
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw classifyProjectGitFailure(result, "fetch", Boolean(options.token));
    }
    const fetchedRefs = await readProjectRemoteRefs({ target: staging }, stagingOptions);
    const updates = [
      ...Array.from(fetchedRefs, ([ref, commit]) => `update ${ref} ${commit}`),
      ...Array.from(currentRefs.keys())
        .filter((ref) => !fetchedRefs.has(ref) && !protectedRefs?.has(ref))
        .map((ref) => `delete ${ref}`),
    ];
    if (updates.length > 0) {
      const updated = await runProjectCheckoutGit(
        input,
        options,
        ["update-ref", "--no-deref", "--stdin"],
        {
          input: `${updates.join("\n")}\n`,
        },
      );
      if (updated.code !== 0 || updated.termination !== "exit") {
        throw new ProjectCloneError(
          "clone_failed",
          "The managed repository changed while its branches were refreshed. Retry the session.",
        );
      }
    }
  } catch (error) {
    retainStaging = hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    if (!retainStaging) {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

async function readProjectRemoteRefs(
  input: { target: string },
  options: ProjectCloneOptions,
): Promise<Map<string, string>> {
  const result = await runProjectCheckoutGit(
    input,
    options,
    ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/remotes/origin"],
    {
      // Refresh needs the complete inventory; diagnostic output keeps its smaller budget.
      maxOutputBytes: { stdout: PROJECT_REF_INVENTORY_MAX_OUTPUT_BYTES, stderr: 256 * 1024 },
    },
  );
  const stdout = requireGitCommandOutput("git for-each-ref", result, (_command, failed) =>
    failed.outputLimitExceeded
      ? new ProjectCloneError(
          "clone_failed",
          `The managed repository ref inventory exceeded the ${PROJECT_REF_INVENTORY_MAX_OUTPUT_BYTES / (1024 * 1024)} MiB refresh limit. Choose a base already available in the checkout or ask the Gateway administrator for help.`,
        )
      : new ProjectCloneError("clone_failed", "Git could not read the managed repository refs."),
  );
  const refs = new Map<string, string>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const match = /^(refs\/remotes\/origin\/\S+) ([a-f0-9]{40}|[a-f0-9]{64})(?: (\S+))?$/u.exec(
      line.trimEnd(),
    );
    if (!match) {
      throw new ProjectCloneError(
        "clone_failed",
        "Git returned an invalid managed repository ref.",
      );
    }
    const [, ref, commit, symbolicTarget] = match;
    if (!ref || !commit) {
      throw new ProjectCloneError(
        "clone_failed",
        "Git returned an incomplete managed repository ref.",
      );
    }
    if (symbolicTarget) {
      continue;
    }
    refs.set(ref, commit);
  }
  return refs;
}

function runProjectCheckoutGit(
  input: { target: string; url?: string },
  options: ProjectCloneOptions,
  args: string[],
  commandOptions: GitCommandOptions = {},
) {
  return runProjectGitCommand(() =>
    executeGitCommand(
      input.target,
      ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args],
      {
        operation: "project.clone",
        timeoutMs: options.timeoutMs ?? PROJECT_CLONE_TIMEOUT_MS,
        signal: options.signal,
        killProcessTree: true,
        maxOutputBytes: 256 * 1024,
        beforeRun: options.assertCurrent,
        startRun: options.startRun,
        ...commandOptions,
        env: {
          ...cloneCommandEnv(input.url, options.token, options.env ?? process.env),
          ...commandOptions.env,
          ...(options.objectDirectory ? { GIT_OBJECT_DIRECTORY: options.objectDirectory } : {}),
        },
      },
    ),
  );
}

/** Fetch the pinned source when a reused project clone predates the remote session. */
export async function ensureProjectCheckoutCommit(
  input: { url: string; target: string; commit: string },
  options: ProjectCloneOptions = {},
): Promise<void> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.commit)) {
    throw new ProjectCloneError("clone_failed", "The repository commit is invalid.");
  }
  const command = (args: string[]) => runProjectCheckoutGit(input, options, args);
  // --missing disables lazy fetching before revision lookup, including on older
  // Git. The commit graph cannot stand in for a physically present commit.
  const present = await command([
    "-c",
    "core.commitGraph=false",
    "rev-list",
    "--missing=allow-any",
    "--no-walk",
    `${input.commit}^{commit}`,
  ]);
  if (present.code === 0 && present.termination === "exit" && present.stdout.trim()) {
    return;
  }
  const fetchCommit = () =>
    command([
      "fetch",
      "--no-auto-maintenance",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      input.url,
      input.commit,
    ]);
  const fetched = await withGitRepositoryRepair({
    cwd: input.target,
    result: await fetchCommit(),
    remote: input.url,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    run: (args, commandOptions) => runProjectCheckoutGit(input, options, args, commandOptions),
    retry: fetchCommit,
  });
  if (fetched.code !== 0 || fetched.termination !== "exit") {
    throw classifyProjectGitFailure(fetched, "fetch", Boolean(options.token));
  }
}

/** Resolve fresh forge-owned base facts without using ambient worktree fetch credentials. */
export async function resolveProjectCheckoutBase(
  input: { url: string; target: string; ref?: string },
  options: ProjectCloneOptions = {},
): Promise<{ commit: string; ref: string }> {
  const command = (args: string[]) => runProjectCheckoutGit(input, options, args);
  const verify = async (ref: string) => {
    const result = await runProjectCheckoutGit(
      input,
      options,
      [
        "-c",
        "core.commitGraph=false",
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref === "-" ? "@{-1}" : ref}^{commit}`,
      ],
      { env: { GIT_NO_LAZY_FETCH: "1" } },
    );
    if (result.termination === "exit" && result.code !== 0) {
      return undefined;
    }
    const commit = requireGitCommandOutput("git rev-parse repository base", result).trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit) || result.stderr.trim()) {
      throw new ProjectCloneError("clone_failed", "Choose an unambiguous repository base ref.");
    }
    return commit;
  };
  if (input.ref !== undefined) {
    const local = await verify(input.ref);
    if (local) {
      return { commit: local, ref: input.ref };
    }
    if (input.ref.startsWith("+")) {
      throw new ProjectCloneError(
        "clone_failed",
        "Use a fully qualified base ref for a name starting with '+', such as refs/heads/+topic.",
      );
    }
    // Remote-tracking selectors name branches, including literal leading '+' names.
    const ref = input.ref.replace(/^(?:refs\/remotes\/)?origin\//u, "refs/heads/");
    // A base selector is not a fetch refspec: reject destination writes and wildcards.
    requireGitCommandOutput(
      "git check-ref-format repository base",
      await command(["check-ref-format", `refs/heads/${ref}`]),
      () =>
        new ProjectCloneError(
          "clone_failed",
          "Choose a branch, tag, or commit as the worktree base.",
        ),
    );
    const fetchRef = () =>
      runProjectCheckoutGit(
        input,
        { ...options, timeoutMs: options.timeoutMs ?? PROJECT_FETCH_TIMEOUT_MS },
        [
          "fetch",
          "--no-auto-maintenance",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          input.url,
          ref,
        ],
      );
    const fetched = await withGitRepositoryRepair({
      cwd: input.target,
      result: await fetchRef(),
      remote: input.url,
      signal: options.signal,
      assertCurrent: options.assertCurrent,
      run: (args, commandOptions) => runProjectCheckoutGit(input, options, args, commandOptions),
      retry: fetchRef,
    });
    if (fetched.code !== 0 || fetched.termination !== "exit") {
      if (
        fetched.termination === "exit" &&
        /couldn't find remote ref|not our ref/iu.test(fetched.stderr)
      ) {
        throw new ProjectCloneError(
          "clone_failed",
          "Worktree base ref does not resolve to a commit. Choose an existing branch, tag, or commit and retry.",
        );
      }
      throw classifyProjectGitFailure(fetched, "fetch", Boolean(options.token));
    }
    const commit = await verify("FETCH_HEAD");
    if (!commit) {
      throw new ProjectCloneError("clone_failed", "The fetched repository base is not a commit.");
    }
    return { commit, ref: input.ref };
  }
  // The advertised symbolic HEAD is authoritative even when its object already
  // exists locally; a stale origin/HEAD must not hide an advanced or renamed default.
  const advertised = await runProjectCheckoutGit(
    input,
    { ...options, timeoutMs: options.timeoutMs ?? PROJECT_FETCH_TIMEOUT_MS },
    ["ls-remote", "--symref", "--", input.url, "HEAD"],
  );
  const stdout = requireGitCommandOutput("git ls-remote repository HEAD", advertised, (_, failed) =>
    classifyProjectGitFailure(failed, "fetch", Boolean(options.token)),
  );
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD\r?$/mu.exec(stdout)?.[1];
  const commit = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\tHEAD\r?$/mu.exec(stdout)?.[1];
  if (!branch || !commit) {
    throw new ProjectCloneError(
      "clone_failed",
      "The repository did not advertise a default branch. Choose an explicit worktree base ref.",
    );
  }
  await ensureProjectCheckoutCommit({ ...input, commit }, options);
  const remoteRef = `refs/remotes/origin/${branch}`;
  requireGitCommandOutput(
    "git update-ref repository default",
    await command(["update-ref", remoteRef, commit]),
  );
  requireGitCommandOutput(
    "git symbolic-ref repository default",
    await command(["symbolic-ref", "refs/remotes/origin/HEAD", remoteRef]),
  );
  return { commit, ref: `origin/${branch}` };
}

/** Observe only the named source branch using the same shared fetch identity as cloning. */
export async function readProjectCheckoutRemoteHead(
  input: { url: string; target: string; branch: string },
  options: ProjectCloneOptions = {},
): Promise<string | undefined> {
  const ref = `refs/heads/${input.branch}`;
  const result = await runProjectCheckoutGit(input, options, [
    "ls-remote",
    "--refs",
    "--",
    input.url,
    ref,
  ]);
  if (result.code !== 0 || result.termination !== "exit") {
    throw new ProjectCloneError(
      "network",
      "The repository branch could not be verified; retry the Gateway move.",
    );
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return undefined;
  }
  const [sha, observedRef, ...extra] = raw.split(/\s+/u);
  if (
    !sha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha) ||
    observedRef !== ref ||
    extra.length
  ) {
    throw new ProjectCloneError("clone_failed", "The repository branch observation is invalid.");
  }
  return sha;
}
