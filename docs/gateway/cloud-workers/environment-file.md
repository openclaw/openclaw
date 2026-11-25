---
summary: "Declare cloud project setup and lifecycle commands with a host-mode devcontainer file"
title: "Cloud environment file"
read_when: "You want repository-defined setup or startup commands for cloud sessions."
doc-schema-version: 1
---

Commit `.devcontainer/devcontainer.json` to customize repository preparation and startup. OpenClaw supports a host-mode subset of the Dev Container specification: commands run directly on the cloud machine as the worker user, in the prepared workspace. It does not start a container.

## Recipe precedence

OpenClaw selects one recipe from the admitted Git commit, in this order:

1. `.devcontainer/devcontainer.json`.
2. `.devcontainer.json` at the repository root.
3. An executable `.openclaw/worktree-setup.sh`.
4. Built-in JavaScript lockfile detection.

Devcontainer files accept JSONC comments and trailing commas. A declared file wins even if it contains no commands; an invalid file reports an error instead of falling back. Uncommitted recipes do not enter shared snapshots. Repository commands require administrator-authorized setup; explicitly skipping setup uses a separate snapshot identity. Local managed worktrees retain their existing setup behavior.

## Lifecycle and snapshots

| Property               | When it runs                                                | Captured?          |
| ---------------------- | ----------------------------------------------------------- | ------------------ |
| `onCreateCommand`      | Initial checkout preparation, before `updateContentCommand` | Filesystem results |
| `updateContentCommand` | Initial preparation and in-place refresh to a new commit    | Filesystem results |
| `postCreateCommand`    | First session binding on each worker, after enrollment      | No                 |
| `postStartCommand`     | At binding, after `postCreateCommand` when present          | No                 |

A verified checkout at the same commit skips preparation commands. On a commit refresh, only `updateContentCommand` reruns; the fallback script and detected installer rerun for their own refreshes. Post-binding commands run before the first turn on both cold machines and snapshot forks. Waking an idle-reclaimed session provisions another worker and runs them again. There is no hook for arbitrary external reboots.

Each command accepts a shell string, an executable-and-arguments array, or an object whose named commands run in parallel. All commands in a phase must succeed. Make declared commands idempotent because an interrupted first binding can retry them.

`containerEnv` and `remoteEnv` supply literal, non-secret strings to lifecycle commands. `remoteEnv` overrides matching `containerEnv` keys; a `null` remote value removes the variable. These values extend the minimal setup environment and do not propagate to session processes. Variable substitution is unsupported.

## Minimal example

```jsonc
{
  "updateContentCommand": ["npm", "ci"],
  "postCreateCommand": "npm run build",
  "postStartCommand": "npm run dev > /tmp/project-dev.log 2>&1 &",
  "remoteEnv": { "NODE_ENV": "development" },
}
```

Dependency installation is reusable in the snapshot. The build and server start after binding, so they see session content. Put process startup in `postStartCommand`: snapshots preserve filesystem state, not running processes.

## Ignored properties

Unsupported properties are ignored with a recorded note. These include `image`, `build`, `dockerComposeFile`, `runArgs`, `mounts`, `remoteUser`, `features`, `hostRequirements`, and `customizations`. OpenClaw does not install Dev Container Features. See the [supported fields above](/gateway/cloud-workers/environment-file#lifecycle-and-snapshots) and setup-secret requests below rather than assuming the full [Dev Container specification](https://containers.dev/implementors/json_reference/) applies.

## Built-in detection

Without a devcontainer file, an executable `.openclaw/worktree-setup.sh` runs before capture. With neither, OpenClaw uses the first matching lockfile:

| Lockfile                  | Preparation                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`          | Enable user-writable Corepack shims, then `pnpm install --frozen-lockfile`                                        |
| `yarn.lock`               | Enable user-writable Corepack shims, then `yarn install --immutable` for Berry or `--frozen-lockfile` for Classic |
| `package-lock.json`       | `npm ci`                                                                                                          |
| `bun.lock` or `bun.lockb` | `bun install --frozen-lockfile`, or skip with a note when Bun is absent                                           |

Yarn's `packageManager` major selects Berry (2+) or Classic; without it, `.yarnrc.yml` selects Berry. No recognized lockfile means no dependency setup. Detection itself does not install Node or Bun; Linux [toolchain bootstrap](/gateway/cloud-workers/setup-and-bundle-installation#automatic-linux-node-toolchains) supplies Node separately.

Detected pnpm and Yarn installs suppress Corepack's download prompt and do not auto-pin `packageManager` in `package.json`.

A failed detected install records a reason and bounded output, skips capture for that run, and lets the session start cold. A failed declared command or fallback script stops dispatch. Changing the recipe changes snapshot compatibility; see [Warm images](/gateway/cloud-workers/warm-images).

## Setup secrets

A devcontainer `secrets` map can request up to 16 POSIX environment names, with optional `description` and `documentationUrl` metadata. For example, `"secrets": { "NPM_TOKEN": { "description": "Private registry access" } }` requests `NPM_TOKEN` from the selected profile's operator-approved `settings.setupSecrets` map. The repository cannot choose store entries, values, or destinations; an unmapped name fails before commands run.

[Configure setup secrets](/gateway/config-cloud-workers#setup-secrets) on the Gateway. Profile setup, repository preparation, and post-create/start commands receive opaque placeholders. Protected egress substitutes credentials only for each secret's bound HTTPS hosts. Approved secret and proxy settings override literal recipe environment values.

This requires a coordinator-owned Linux lease, a known machine class for protected repository preparation, and Crabbox's native egress helper. Unavailable support fails visibly with no plaintext fallback. Access ends when the lifecycle command finishes, so detached servers cannot retain it. Secrets do not disable snapshots.
