import { spawnSync } from "node:child_process";
import { constants, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withWorktreeAllocationLease } from "../../src/agents/worktrees/allocation.js";
import {
  estimateWorktreeGitBytes,
  requireWorktreeDiskSpace,
} from "../../src/agents/worktrees/capacity.js";
import { addManagedWorktree } from "../../src/agents/worktrees/checkout.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "../../src/agents/worktrees/git.js";
import {
  executeGitCommand,
  executeGitCommandBuffered,
  executeGitCommandBytes,
  normalizeGitPathForFilesystem,
  requireGitCommandOutput,
} from "../../src/infra/git-exec.js";
import { isDirectRunUrl } from "../lib/direct-run.mjs";

type ProvisionParams = {
  root: string;
  pr: string;
  seed: string;
  lockRef: string;
  ownerOid: string;
  signal?: AbortSignal;
};
type GitPolicyReader = (args: string[]) => ReturnType<typeof executeGitCommand>;

/** Preserve native PR hooks without enabling them in Gateway-owned Git. */
async function needsNativeGit(git: GitPolicyReader, env: NodeJS.ProcessEnv): Promise<boolean> {
  // Managed Git replaces GIT_CONFIG_COUNT, so keep those callers on native Git.
  // GIT_CONFIG_PARAMETERS is preserved, including the supervisor's maintenance
  // lifetime settings; effective hook/fsmonitor/include policy is checked below.
  if (
    Object.entries(env).some(
      ([name, value]) =>
        value !== undefined &&
        /^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES))$/i.test(
          name,
        ),
    )
  ) {
    return true;
  }
  const conditional = await git(["config", "--get-regexp", "^includeif\\."]);
  if (conditional.termination !== "exit" || conditional.code !== 1) {
    // Conditions can change when Git switches from the source to the new branch/path.
    return true;
  }
  const worktreeConfig = await git(["config", "--get-regexp", "^extensions\\.worktreeconfig$"]);
  if (worktreeConfig.termination !== "exit" || worktreeConfig.code !== 1) {
    // Source and destination can have different hook/fsmonitor settings.
    return true;
  }
  const fsmonitor = await git(["config", "--type=bool", "--get", "core.fsmonitor"]);
  if (
    fsmonitor.termination !== "exit" ||
    (fsmonitor.code !== 1 && !(fsmonitor.code === 0 && fsmonitor.stdout.trim() === "false"))
  ) {
    return true;
  }
  const configuredHooks = await git(["config", "--null", "--get-all", "core.hooksPath"]);
  if (configuredHooks.termination !== "exit") {
    return true;
  }
  if (configuredHooks.code === 0) {
    const hooks = configuredHooks.stdout.split("\0").filter(Boolean);
    return (
      (configuredHooks.stdoutTruncatedBytes !== undefined &&
        configuredHooks.stdoutTruncatedBytes > 0) ||
      hooks.length !== 1 ||
      hooks[0] !== os.devNull
    );
  }
  if (configuredHooks.code !== 1) {
    return true;
  }
  const hooksResult = await git(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  if (
    hooksResult.termination !== "exit" ||
    hooksResult.code !== 0 ||
    hooksResult.stdoutTruncatedBytes
  ) {
    return true;
  }
  const hooksPath = normalizeGitPathForFilesystem(
    requireGitCommandOutput("git rev-parse --git-path hooks", hooksResult).trim(),
  );
  let hookNames: string[];
  try {
    hookNames = await fs.readdir(hooksPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  try {
    for (const name of hookNames) {
      if (name.endsWith(".sample")) {
        continue;
      }
      const entry = path.join(hooksPath, name);
      const stat = await fs.stat(entry);
      if (stat.isFile()) {
        try {
          await fs.access(entry, constants.X_OK);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EACCES") {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    // A dangling/unreadable hook is indeterminate, not proof of an empty directory.
    return true;
  }
}

let advertisedCleanupGrace = false;

async function provisionPrWorktree(params: ProvisionParams): Promise<void> {
  if (
    !/^[1-9][0-9]*$/.test(params.pr) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(params.seed) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(params.ownerOid) ||
    params.lockRef !== `refs/openclaw/pr-operation-locks/${params.pr}`
  ) {
    throw new Error("Invalid native PR provisioning identity.");
  }
  const env = { ...process.env };
  const root = await fs.realpath(params.root);
  const stateDir = path.join(root, ".local", "pr-state");
  // Wrapper leases and template records must never open the operator's Gateway database.
  const storageEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  const lockOwner = fileURLToPath(new URL("./operation-lock.sh", import.meta.url));
  const assertPrAuthority = () => {
    // Consume the shell owner's current-ref predicate; do not invent a second lock.
    const checked = spawnSync(
      process.platform === "win32" ? "bash" : "/bin/bash",
      [
        "-c",
        'source "$1"; pr_operation_lock_owner_is_current "$2" "$3" "$4"',
        "pr-provision-authority",
        lockOwner,
        root,
        params.lockRef,
        params.ownerOid,
      ],
      {
        cwd: root,
        env: { ...env, GIT_NO_LAZY_FETCH: "1" },
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (checked.status !== 0) {
      throw new Error(
        "PR operation lock changed or is unreadable; retain provisioning state for recovery.",
      );
    }
  };
  assertPrAuthority();
  await withWorktreeAllocationLease(
    { env: storageEnv, signal: params.signal, commitGuard: assertPrAuthority },
    async (guard) => {
      const assertCurrent = () => {
        guard.signal?.throwIfAborted();
        guard.commitGuard();
      };
      const gitOptions = {
        env,
        baseEnv: env,
        signal: guard.signal,
        beforeRun: assertCurrent,
        killProcessTree: true,
      };
      const rawGit = async (args: string[], cwd = root) => {
        assertCurrent();
        const result = await executeGitCommand(cwd, args, gitOptions);
        assertCurrent();
        return result;
      };
      const requiredGit = async (cwd: string, args: string[]) =>
        requireGitCommandOutput(`git ${args.join(" ")}`, await rawGit(args, cwd)).trim();
      // Native scripts/pr addresses its owner as the common Git directory's
      // parent. Preserve caller command-scoped Git policy in these reads too:
      // the managed Git helpers deliberately replace GIT_CONFIG_COUNT.
      const commonDir = await fs.realpath(
        normalizeGitPathForFilesystem(
          await requiredGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        ),
      );
      const topLevel = await fs.realpath(
        normalizeGitPathForFilesystem(
          await requiredGit(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
        ),
      );
      if ((await fs.realpath(path.dirname(commonDir))) !== root || topLevel !== root) {
        throw new Error("PR provisioning requires the canonical repository root.");
      }
      const branch = `temp/pr-${params.pr}`;
      const seedRef = `refs/heads/${branch}`;
      const assertSeed = async () => {
        const observed = await requiredGit(root, ["rev-parse", "--verify", `${seedRef}^{commit}`]);
        if (observed !== params.seed) {
          throw new Error(
            "PR seed branch moved; preserve it and retry through native PR recovery.",
          );
        }
      };
      await assertSeed();
      const worktreeRoot = path.join(root, ".worktrees");
      const resolvedWorktreeRoot = await fs.realpath(worktreeRoot).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return worktreeRoot;
      });
      const destination = path.join(resolvedWorktreeRoot, `pr-${params.pr}`);
      // Native PR tooling supports a symlinked parent. Keep that path on Git
      // rather than registering managed templates under an aliased namespace.
      const native = resolvedWorktreeRoot !== worktreeRoot || (await needsNativeGit(rawGit, env));
      const gitBytes = await estimateWorktreeGitBytes(root, params.seed, {
        signal: guard.signal,
        assertCurrent,
        // The capacity worker must preserve the same caller policy as native
        // checkout. The broker still captures env, fences effects and joins Git.
        git: native
          ? { text: executeGitCommandBytes, buffered: executeGitCommandBuffered }
          : undefined,
      });
      // Capacity rounds every blob up to 4 KiB. Allow 16 small files/second
      // on loaded disks, plus startup time, bounded to four hours per checkout.
      const checkoutBudget = {
        timeoutMs: Math.min(
          4 * 60 * 60_000,
          WORKTREE_CHECKOUT_TIMEOUT_MS + Math.ceil(gitBytes / 65_536) * 1000,
        ),
        // Deletion is cheaper than checkout, but Git must finish its signal cleanup
        // before the process owner escalates. Keep the same measured size input.
        killGraceMs: Math.min(30 * 60_000, 30_000 + Math.ceil(gitBytes / 1024 ** 2) * 1000),
      };
      if (env.OPENCLAW_PR_LOCK_NOTIFY_FD === "3") {
        // The supervisor must keep this process alive while it joins Git and
        // removes an owned partial checkout after an external interrupt.
        writeSync(
          3,
          `phase\tcleanup-grace\t${checkoutBudget.timeoutMs + checkoutBudget.killGraceMs}\n`,
        );
        advertisedCleanupGrace = true;
      }
      const requireSpace = (cloneBytes?: number) => {
        assertCurrent();
        requireWorktreeDiskSpace(
          [
            { path: destination, bytes: cloneBytes ?? 2 * gitBytes },
            { path: commonDir, bytes: 0 },
            { path: root, bytes: 0 },
            { path: stateDir, bytes: 0 },
          ],
          "worktree allocation",
        );
      };
      assertCurrent();
      requireSpace(0);
      await fs.mkdir(worktreeRoot, { recursive: true });
      assertCurrent();
      if ((await fs.realpath(worktreeRoot)) !== resolvedWorktreeRoot) {
        throw new Error("PR worktree parent changed during provisioning.");
      }
      await assertSeed();
      let templateCloned = false;
      if (native) {
        // Exclusive reservation proves custody; an old damaged checkout is never adopted.
        requireSpace();
        await fs.mkdir(destination);
        const reserved = await fs.lstat(destination);
        const removeReservation = async (recursive: boolean) => {
          // Git removes registration before the directory. Its forced termination
          // can interrupt that walk, even after .git itself has been removed.
          // Reuse the cleanup owner's complete backlink scan; never infer absence
          // from Git's listing, which silently omits damaged admin entries.
          const state = spawnSync(
            process.platform === "win32" ? "bash" : "/bin/bash",
            [
              "-c",
              'set -euo pipefail; source "$1/worktree.sh"; source "$1/common.sh"; canonical_repo_root="$2"; pr_worktree_state "$3" | jq -er \'select(.present and .admin == "") | .path\'',
              "pr-provision-cleanup",
              path.dirname(lockOwner),
              root,
              destination,
            ],
            {
              cwd: root,
              env,
              encoding: "utf8",
              timeout: 10_000,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          if (state.status === 0 && state.stdout.trimEnd() === destination) {
            if ((await fs.realpath(worktreeRoot)) !== resolvedWorktreeRoot) {
              throw new Error("PR worktree parent changed; retain interrupted checkout.");
            }
            const retained = await fs.lstat(destination);
            if (
              retained.dev !== reserved.dev ||
              retained.ino !== reserved.ino ||
              !retained.isDirectory()
            ) {
              throw new Error("PR worktree destination changed; retain interrupted checkout.");
            }
            guard.rollbackGuard();
            assertPrAuthority();
            try {
              if (recursive) {
                await fs.rm(destination, { recursive: true });
              } else {
                await fs.rmdir(destination);
              }
            } catch (error) {
              if (
                !recursive &&
                ["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
              ) {
                return;
              }
              throw error;
            }
            console.error("Removed failed PR checkout reservation.");
          }
        };
        let admitted = false;
        const added = await executeGitCommand(
          root,
          ["worktree", "add", "--", destination, branch],
          {
            ...gitOptions,
            ...checkoutBudget,
            beforeRun: () => {
              assertCurrent();
              admitted = true;
            },
          },
        ).catch(async (error: unknown) => {
          if (!admitted) {
            await removeReservation(false);
          }
          throw error;
        });
        if (added.code !== 0 && added.cleanup && added.cleanup !== "uncertain") {
          await removeReservation(
            added.termination === "timeout" || added.termination === "signal",
          );
        }
        // Git still owns hooks; keep registered checkouts, hook edits and seed refs.
        requireGitCommandOutput("git worktree add", added);
      } else {
        // Native Git does not consume acceleration policy; keep config startup
        // out of that entry path, including hook and sparse-checkout fallbacks.
        const { createConfigIO } = await import("../../src/config/config.js");
        assertCurrent();
        const added = await addManagedWorktree({
          ...guard,
          env: storageEnv,
          now: Date.now,
          enabled: createConfigIO({ env: storageEnv }).loadConfig().worktreeAcceleration !== false,
          repoRoot: root,
          commonDir,
          worktreeRoot,
          destination,
          base: params.seed,
          branch: { mode: "existing", name: branch },
          checkoutBudget,
          requireSpace,
          commitGuard: assertCurrent,
        });
        requireGitCommandOutput("managed PR worktree add", added);
        templateCloned = added.templateCloned === true;
      }
      assertCurrent();
      // Both paths retain native PR ownership. Identity checks do not erase hook edits.
      const top = normalizeGitPathForFilesystem(
        await requiredGit(destination, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
      );
      const common = normalizeGitPathForFilesystem(
        await requiredGit(destination, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      );
      if (
        (await fs.realpath(worktreeRoot)) !== resolvedWorktreeRoot ||
        (await fs.realpath(top)) !== destination ||
        (await fs.realpath(common)) !== commonDir ||
        (await requiredGit(destination, ["symbolic-ref", "HEAD"])) !== seedRef ||
        (await requiredGit(destination, ["rev-parse", "--verify", "HEAD"])) !== params.seed
      ) {
        throw new Error(
          "PR checkout identity changed; retain the caller branch and checkout for recovery.",
        );
      }
      await assertSeed();
      assertCurrent();
      console.error(
        templateCloned
          ? "PR source checkout: filesystem template clone."
          : "PR source checkout: Git checkout.",
      );
    },
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const controller = new AbortController();
  const signals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
  const abort = () =>
    controller.abort(new Error("PR provisioning interrupted; retain native recovery state."));
  for (const signal of signals) {
    process.on(signal, abort);
  }
  try {
    const [root, pr, seed, lockRef, ownerOid, ...extra] = process.argv.slice(2);
    if (!root || !pr || !seed || !lockRef || !ownerOid || extra.length) {
      throw new Error("Usage: worktree-provision.mts <root> <PR> <seed> <lock-ref> <owner-oid>");
    }
    await provisionPrWorktree({ root, pr, seed, lockRef, ownerOid, signal: controller.signal });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    console.error("[pr-worktree-provision] FAILED (exit 1)");
  } finally {
    if (advertisedCleanupGrace) {
      writeSync(3, "phase\tcleanup-grace\t0\n");
    }
    for (const signal of signals) {
      process.off(signal, abort);
    }
  }
}
