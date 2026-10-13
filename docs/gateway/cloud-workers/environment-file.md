---
summary: "Declare cloud project setup and lifecycle commands with a host-mode devcontainer file"
title: "Cloud environment file"
read_when: "You want repository-defined setup or startup commands for cloud sessions."
---

Commit a `.devcontainer/devcontainer.json` file to prepare a cloud repository once and reuse its installed dependencies in later sessions. OpenClaw supports a host-mode subset of the [Dev Container specification](https://containers.dev/implementors/json_reference/): commands run directly on the cloud machine as the worker user, with the prepared workspace as their working directory.

## Recipe precedence

OpenClaw resolves one recipe from the admitted Git commit, in this order:

1. `.devcontainer/devcontainer.json`.
2. `.devcontainer.json` at the repository root.
3. The committed executable `.openclaw/worktree-setup.sh`.
4. Built-in JavaScript dependency detection.

Both devcontainer paths accept JSONC, including comments and trailing commas. A devcontainer file takes precedence even when it declares no lifecycle commands; OpenClaw does not also run the fallback script or detected installer. An invalid declared recipe reports a dispatch error rather than falling back silently.

Repository commands use the same administrator-authorized setup gate as the existing worktree setup script. Explicitly skipping setup keeps a separate preparation identity. This recipe resolution applies to cloud project preparation; local managed worktrees on the Gateway host retain their existing setup behavior.

## Lifecycle and snapshots

| Property               | When OpenClaw runs it                                                                  | Included in the snapshot?   |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| `onCreateCommand`      | First preparation of a checkout, before `updateContentCommand`                         | Yes, its filesystem results |
| `updateContentCommand` | Initial preparation and an in-place refresh to a new commit                            | Yes, its filesystem results |
| `postCreateCommand`    | Once per worker, after enrollment and session workspace binding, before the first turn | No                          |
| `postStartCommand`     | After `postCreateCommand` when the worker is bound for a machine start                 | No                          |

On an in-place commit refresh, only `updateContentCommand` reruns; `onCreateCommand` does not. A verified checkout at the same commit skips preparation commands. The fallback script and detected installer run again when their checkout refreshes.

Both cold provisioning and snapshot forks run the post-binding commands. Here, **start** means every machine start OpenClaw performs. Idle reclaim destroys the environment; waking the session provisions another worker and runs `postCreateCommand`, then `postStartCommand` again. OpenClaw does not install a hook for arbitrary external machine reboots. Put process startup in `postStartCommand`, because snapshots retain filesystem state rather than running processes.

Each lifecycle command supports these forms:

- A string runs through the shell.
- An array names the executable and its arguments, without a shell.
- An object runs its named commands in parallel. Every command must succeed before the phase completes.

`containerEnv` and `remoteEnv` provide literal, non-secret string values for lifecycle commands. `remoteEnv` overrides matching `containerEnv` keys; a `null` value removes the variable for lifecycle commands. These values extend the minimal setup environment; they do not propagate to session processes. Environment-variable substitution and setup secrets are outside this subset. Declared commands should be idempotent: an interrupted first binding can retry before activation records completion.

## Minimal example

```jsonc
{
  "name": "Project tools",
  "updateContentCommand": ["npm", "ci"],
  "postCreateCommand": "npm run build",
  "postStartCommand": "npm run dev > /tmp/project-dev.log 2>&1 &",
  "remoteEnv": {
    "NODE_ENV": "development",
  },
}
```

The dependency installation can be captured and reused. The build and development server run after the session workspace is bound, so they see session content and never enter the shared snapshot.

## Ignored properties

Container-specific or unsupported properties never fail preparation. OpenClaw records one concise ignored-properties note, such as `devcontainer image ignored on cloud machines`. This includes `image`, `build`, `dockerComposeFile`, `runArgs`, `mounts`, `remoteUser`, `features`, `hostRequirements`, `secrets`, and `customizations`. OpenClaw does not start a container or install Dev Container Features from this file.

## Built-in detection

With neither a devcontainer file nor an executable fallback script, OpenClaw chooses the first matching JavaScript lockfile:

| Lockfile                  | Preparation                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm-lock.yaml`          | Enable Corepack shims in a user-writable directory, without `sudo`, then `pnpm install --frozen-lockfile`                                                                                              |
| `yarn.lock`               | Enable Corepack shims in a user-writable directory, then `yarn install --immutable` for Berry, detected from `packageManager` or `.yarnrc.yml`; otherwise `yarn install --frozen-lockfile` for Classic |
| `package-lock.json`       | `npm ci`                                                                                                                                                                                               |
| `bun.lock` or `bun.lockb` | `bun install --frozen-lockfile` when Bun is on `PATH`; otherwise skip with a note                                                                                                                      |

No recognized lockfile means no dependency setup. Detection does not install Node or Bun.

A failed detected install records a reason and a bounded output tail, skips snapshot capture for that run, and lets the session start cold. A failed declared devcontainer command or fallback script keeps the existing visible dispatch failure.

Preparation diagnostics exposed by `crabbox.images.list` include the recipe source (`devcontainer`, `script`, `detected`, or `none`), the ignored-properties note, phase durations, and failure output limited to 16 KiB. Recipe identity uses the devcontainer file blob, the fallback script blob, or the built-in recipe version and detected lockfile blob hashes. Changing the resolved recipe therefore changes its preparation identity.

See [Warm images](/gateway/cloud-workers/warm-images) for capture and reuse, and [Worker setup and bundle installation](/gateway/cloud-workers/setup-and-bundle-installation) for machine prerequisites and the OpenClaw runtime.
