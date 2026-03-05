---
summary: "Operator-focused addendum for Docker installs (Global Compass + status decoder)"
title: "Docker -- Operator Install Safeguards"
---

## Operator install clarity pack (Docker chapter add-on)

### Note for Apple Silicon / M4 Users
- **Run the Global Compass first:** Confirm Rosetta, free disk (>=15 GB), Docker Desktop running, and Terminal Full Disk Access (see [Global Compass](#operator-global-compass-pre-flight)).
- **Wait for Docker to settle:** After updates the whale icon pulses for ~90 s--running compose before it stabilizes causes mount failures unique to M4 laptops.
- **Protect the gateway from JSON typos:** Before editing `~/.openclaw/openclaw.json`, run a lint + backup step (`python3 -m json.tool <file>` / `jq` + temp file) so malformed configs never hit disk; if you prefer automation, refer to the forthcoming tooling PR that carries the experimental config-guard add-on.
- **Keep subagent auth in sync:** Copy or symlink `~/.openclaw/auth-profiles.json` into each `~/.openclaw/agents/<name>/` directory right after the Docker step. This prevents the `No API key for provider "anthropic"` loop captured in the [Status Playbook logbook](./status-playbook.md#hardcore-logbook-field-captures).
- **Bookmark the Status Decoder:** If you see `token mismatch` or `gateway restarting`, jump to the [Status decoder](#status-decoder-keep-nearby) table below--it translates every log referenced in this note.

### Operator Global Compass (pre-flight)
#### Apple Silicon (M1-M4)
- [ ] Rosetta installed: `softwareupdate --install-rosetta --agree-to-license`.
- [ ] Docker Desktop running with a steady whale icon; >=15 GB free disk.
- [ ] Terminal granted Full Disk Access; PATH not clobbered by legacy shells.

#### Intel Mac
- [ ] `brew update && brew upgrade` succeeds.
- [ ] Docker Desktop resources >=4 CPU / 6 GB RAM; laptop on power.

#### Linux / VPS
- [ ] `sudo -n true` works (or be ready to enter password repeatedly).
- [ ] `locale` shows UTF-8; `df -h ~` >=10 GB free.
- [ ] `docker info` / `docker ps` both succeed.

#### Windows / WSL2
- [ ] WSL2 enabled with the repo living inside the WSL ext4 filesystem (avoid `/mnt/c`).
- [ ] Developer Mode + Long Paths enabled in Windows settings.

### Platform runbook highlights
- **Apple Silicon:** Wait for Docker to finish "starting" before running `docker-setup.sh`; `health: starting` <120 s is normal on cold boots.
- **Intel Mac:** Update Homebrew first; slower image pulls are expected.
- **Linux / VPS:** Remember "repo root != ~/.openclaw"; run Docker commands from the clone, not the data directory.
- **Windows / WSL2:** Keep every command inside WSL; add `export PATH="$HOME/.npm-global/bin:$PATH"` if binaries aren't found.

### Status decoder (keep nearby)
- `gateway restarting` loop -> config schema error; lint first, then rollback.
- `No API key for provider "anthropic"` -> subagent `auth-profiles.json` not synced.
- `token mismatch` / `1008` -> Control UI token expired; rerun `openclaw dashboard --no-open`.
- `docker compose` mount failures -> you're in `~/.openclaw`; switch back to the repo root.

> Automation note: The automation scripts (config-guard, auth-sync, etc.) are available in our experimental repo and will be proposed in a separate Tooling PR once these docs land.

### Pain -> comfort map
| Pain | Root cause | Mitigation |
| --- | --- | --- |
| Subagent auth desync | Each agent keeps its own `auth-profiles.json`. | Hash-compare/symlink before spawning (future tooling will automate this). |
| Running `docker compose` inside `~/.openclaw` | Repo root != data directory. | Abort when `pwd` equals `~/.openclaw` and instruct users to return to the repo. |
| `gateway restarting` loop | No dry-run lint/rollback guardrail. | Use the config guard workflow or `python3 -m json.tool` + backup-before-overwrite. |
