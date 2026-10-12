# Exceptional Crabbox operations

Use only after [Crabbox routing and safety](../SKILL.md).

## Repository Contract

This canonical skill owns portable Crabbox policy and CLI operations only.
Consumer-specific setup belongs in that repository's `AGENTS.md`, package
scripts, hydration workflow, or another file outside the synchronized skill.

Resolve these placeholders from trusted repository instructions before running
an example:

- `<check-command>`: the repository's focused or broad validation command.
- `<install-and-check-command>`: its clean-container install plus validation.
- `<trusted-bootstrap-script>`: a maintainer-reviewed untrusted-PR bootstrap
  stored outside the untrusted checkout.
- `<container-image>` and `<owner/repo#number>`: the consumer's runtime and PR.

Never invent a missing command or copy a command from another consumer.

### Blacksmith directory downloads

Blacksmith CLI 0.4.60 (verified 2026-09-19) needs a trailing `/` on the **remote
directory argument** to enable recursive SCP; otherwise it fails with
`not a regular file`. A local trailing slash does not help, and SCP may add `/`
in the error text even when the caller omitted it.

```sh
mkdir -p ./downloads
blacksmith testbox download --id <tbx_id> screenshots/ ./downloads/
```

Use an explicit destination: this writes `./downloads/screenshots/`; omitting
it can duplicate the basename (`screenshots/screenshots/`). Reuse the task-owned
lease and existing key path (`--ssh-private-key` when needed). Verify the downloaded
tree and hashes; recheck this workaround after CLI upgrades.

## Observability

Prefer built-ins:

- `--preflight`: target/workspace/tool probes.
- `--debug --timing-json`: sync, command, total timing.
- `--script <file>` / `--script-stdin`: safe multiline direct-provider command.
- `--allow-env NAME` + `--env-from-profile <file>`: exact direct-provider env.
- `CRABBOX_ENV_ALLOW=NAME,...`: exact ambient env allowlist.
- `--capture-stdout`, `--capture-stderr`: direct-provider local capture.
- `--capture-on-fail`: test artifacts. Treat as secret-bearing until reviewed.
- `--keep-on-failure`: retain failed lease for debugging.
- `--results-auto` / `--junit <path>`: structured failure digest.
- `CRABBOX_PHASE:<name>` lines: phase timing.

Secrets: exact key only. One command. Never print. Never repo file. Never shell
history. No safe injection path? Report live auth blocked. No fake-key upgrade to
“live proof.”

## Real E2E

“Test in Crabbox” means user path, not merely remote unit tests.

1. Reproduce entrypoint when feasible.
2. Patch. Narrow local test.
3. Remote install/update/onboard/CLI/service/API path.
4. Record provider, id, command, environment shape, redacted secret source,
   observed result.
5. Cleanup.

Route:

- Install/package: pack tarball; install like user; matching Docker/package lane.
- Provider/auth: real provider. Scrub unrelated provider vars.
- Integration: setup, config, send/receive, and inspect redacted logs.
- Service/session/tool: real CLI or API; inspect persisted state and result.
- Parser/config: focused tests enough only when OS/package/service cannot matter.

Before/after: same Testbox when practical. Detached temp worktrees under `/tmp`.
Never checkout refs in synced root. For native Testbox, prepare and compare both
revisions within one synced invocation; later runs sync the local checkout again.
Full-screen CLI: real PTY. Interactive Clack: exact arrows/Enter; raw search
typing can lie.

Use the consumer's documented temporary state/config directory so proof cannot
mutate the operator's normal installation.

## Desktop and cross-OS

Static hosts:

```sh
"$CRABBOX" run --provider ssh --target macos \
  --static-host <macos-host> -- <check-command>
"$CRABBOX" run --provider ssh --target windows --windows-mode normal \
  --static-host <windows-host> -- pwsh -NoProfile -Command '<check-command>'
"$CRABBOX" run --provider ssh --target windows --windows-mode wsl2 \
  --static-host <windows-host> -- <check-command>
```

Windows/WSL2: prefer Azure when advertised/configured. Native Windows uses
OpenSSH + PowerShell + Git + tar. Actions hydration Linux-only.

Brokered macOS: paid EC2 Mac. First quota/no-spend preflight. No silent
substitution for Linux proof.

```sh
"$CRABBOX" admin hosts quota --provider aws --target macos \
  --region eu-west-1 --type mac2.metal --json
"$CRABBOX" admin hosts allocate --provider aws --target macos \
  --region eu-west-1 --type mac2.metal --dry-run --json
```

Human desktop: WebVNC preferred when the resolved provider supports it. Do not
change providers only to gain desktop support.

```sh
"$CRABBOX" warmup --desktop --browser --keep
"$CRABBOX" desktop launch --id <id> \
  --browser --url https://example.com --webvnc --open --take-control
"$CRABBOX" desktop doctor --id <id>
"$CRABBOX" webvnc status --id <id>
"$CRABBOX" artifacts collect --id <id> --all --output artifacts/<slug>
```

Before handoff, prove CLI/app from neutral `~`:

```sh
"$CRABBOX" run --id <id> --shell -- \
  "cd ~ && command -v <command> && <command> --version"
```

Visible desktop alone proves nothing. Keep browser windowed unless capture task.
Never commit proof assets to product repo.

## Direct AWS

Trusted direct run:

```sh
"$CRABBOX" run \
  --provider aws \
  --idle-timeout 90m --ttl 240m --timing-json \
  --shell -- \
  "<check-command>"
```

Focused:

```sh
"$CRABBOX" run \
  --provider aws --timing-json --shell -- \
  "<check-command>"
```

Stale sync: retry `--full-resync` once. Still bad: fresh lease. One-shot should
stop itself; after failure/interruption verify `"$CRABBOX" list --provider aws`.

Broker auth, not cloud keys:

```sh
"$CRABBOX" config show
"$CRABBOX" doctor
"$CRABBOX" whoami
"$CRABBOX" login --url <broker-url> --provider aws
```

Normal validation asking for AWS keys usually means wrong path.

## Fresh PR / Container

`--fresh-pr <owner/repo#123>`: clean remote checkout. Add `--apply-local-patch`
only for intentional local fixup. Direct providers only.

Use local Docker only when the resolved configuration selects it or the user
explicitly requests a local-container lane:

```sh
"$CRABBOX" run \
  --provider local-container \
  --local-container-image <container-image> \
  --no-hydrate --fresh-pr <owner/repo#number> \
  --timing-json --shell -- \
  "<install-and-check-command>"
```

Report `local-container`; not AWS/Testbox. Keep `--no-hydrate` and use a
repository-local dependency cache when host-mounted caches cannot cross filesystems.
