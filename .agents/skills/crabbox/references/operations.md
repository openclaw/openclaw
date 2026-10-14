# Exceptional Crabbox operations

Use only after [Crabbox routing and safety](../SKILL.md).

## Repository Contract

- Canonical skill owns portable Crabbox policy + CLI operations only.
- Consumer-specific setup: that repository's `AGENTS.md`, package scripts,
  hydration workflow, or another file outside synchronized skill.
- Before running examples, resolve placeholders from trusted repository instructions:
  - `<check-command>`: repository's focused/broad validation command.
  - `<install-and-check-command>`: clean-container install + validation.
  - `<trusted-bootstrap-script>`: maintainer-reviewed untrusted-PR bootstrap,
    stored outside untrusted checkout.
  - `<container-image>` + `<owner/repo#number>`: consumer's runtime + PR.
- Never invent missing commands or copy another consumer's command.

### Blacksmith directory downloads

- Blacksmith CLI 0.4.60 (verified 2026-09-19): **remote directory argument**
  needs trailing `/` for recursive SCP; otherwise fails with `not a regular file`.
- Local trailing slash cannot help. SCP may add `/` in error text even when caller
  omitted it.

```sh
mkdir -p ./downloads
blacksmith testbox download --id <tbx_id> screenshots/ ./downloads/
```

- Explicit destination: writes `./downloads/screenshots/`; omission can duplicate
  basename (`screenshots/screenshots/`).
- Reuse task-owned lease + existing key path (`--ssh-private-key` when needed).
- Verify downloaded tree + hashes; recheck workaround after CLI upgrades.

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
history. No safe injection path: report live auth blocked. No fake-key upgrade to
“live proof.”

## Real E2E

“Test in Crabbox” = user path, not merely remote unit tests.

1. Reproduce entrypoint when feasible.
2. Patch. Narrow local test.
3. Remote install/update/onboard/CLI/service/API path.
4. Record provider, id, command, environment shape, redacted secret source,
   observed result.
5. Cleanup.

Route:

- Install/package: pack tarball; install like user; matching Docker/package lane.
- Provider/auth: real provider. Scrub unrelated provider vars.
- Integration: setup, config, send/receive, inspect redacted logs.
- Service/session/tool: real CLI/API; inspect persisted state + result.
- Parser/config: focused tests enough only when OS/package/service cannot matter.

- Before/after: same Testbox when practical. Detached temp worktrees under `/tmp`.
  Never checkout refs in synced root.
- Native Testbox: prepare/compare both revisions within one synced invocation;
  later runs sync local checkout again.
- Full-screen CLI: real PTY. Interactive Clack: exact arrows/Enter; raw search
  typing can lie.
- Use consumer's documented temporary state/config directory; proof must not
  mutate operator's normal installation.

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

- Windows/WSL2: prefer Azure when advertised/configured. Native Windows:
  OpenSSH + PowerShell + Git + tar. Actions hydration Linux-only.
- Brokered macOS: paid EC2 Mac. Run quota/no-spend preflight first. No silent
  substitution for Linux proof.

```sh
"$CRABBOX" admin hosts quota --provider aws --target macos \
  --region eu-west-1 --type mac2.metal --json
"$CRABBOX" admin hosts allocate --provider aws --target macos \
  --region eu-west-1 --type mac2.metal --dry-run --json
```

Human desktop: prefer WebVNC when resolved provider supports it. Do not change
providers only to gain desktop support.

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

- Visible desktop alone proves nothing. Browser windowed unless capture task.
- Never commit proof assets to product repo.

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

- Stale sync: retry `--full-resync` once; still bad: fresh lease.
- One-shot should stop itself. After failure/interruption: verify
  `"$CRABBOX" list --provider aws`.

Broker auth, not cloud keys:

```sh
"$CRABBOX" config show
"$CRABBOX" doctor
"$CRABBOX" whoami
"$CRABBOX" login --url <broker-url> --provider aws
```

Normal validation asking for AWS keys usually means wrong path.

## Fresh PR / Container

- `--fresh-pr <owner/repo#123>`: clean remote checkout. Direct providers only.
- Add `--apply-local-patch` only for intentional local fixup.
- Local Docker only when resolved configuration selects it or user explicitly
  requests local-container lane:

```sh
"$CRABBOX" run \
  --provider local-container \
  --local-container-image <container-image> \
  --no-hydrate --fresh-pr <owner/repo#number> \
  --timing-json --shell -- \
  "<install-and-check-command>"
```

- Report `local-container`; not AWS/Testbox. Keep `--no-hydrate`.
- Host-mounted caches cannot cross filesystems: use repository-local dependency cache.
