# Duplicate-triage tool setup

### Install the CLIs

Install `prtags` from the pinned release below.
Do not rely on an old local build unless the maintainer explicitly wants to test unreleased behavior.

`prtags` CLI install path:

```bash
GOBIN="$HOME/.local/bin" go install github.com/dutifuldev/prtags/cmd/prtags@v0.1.2
```

`prtags` lives outside the OpenClaw organization, so this install stays pinned to a reviewed
version that the Go module proxy resolves and the public checksum database verifies. `GOBIN` keeps
the installed executable in the same user-local directory as the previous installer, so an existing
`$HOME/.local/bin` `PATH` continues to resolve the newly installed version.
Do not install it by piping a remote script into a shell, and do not point the install at a branch:
either one executes whatever that third party serves at run time, with the maintainer's own
privileges. Moving to a newer `prtags` release is a reviewed change to this file, not a mid-task step.

### Authenticate prtags

`prtags` should be logged in with the maintainer's own GitHub account through OAuth device flow.
Do not use a shared maintainer token for interactive triage.

```bash
prtags auth login
prtags auth status
```

The expected outcome is that `prtags` stores the logged-in maintainer identity locally and uses that account for authenticated writes.
