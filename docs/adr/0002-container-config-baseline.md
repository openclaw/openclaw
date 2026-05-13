# ADR-002: OpenClaw Container Configuration Baseline

- **Status:** Accepted (baseline)
- **Date:** 2026-05-13
- **Deciders:** Tony (brickjawn)
- **Captured by:** Claude Code, sprint-002 discovery
- **Supersedes:** None
- **Superseded by:** None
- **Related:** ADR-0001 (hybrid-routing-and-rrf-memory) — documents the
  RRF memory architecture referenced as "NOT ACTIVE" below

---

## Context

This ADR establishes the verified configuration of the running OpenClaw
gateway as of capture date. It serves as the canonical baseline against
which future drift is detected.

The need for this baseline emerged during a Discord channel-routing
investigation that revealed:

1. Source-of-truth ambiguity between `~/Projects/OpenClaw/OpenClaw/`
   (TypeScript repo) and `~/.openclaw/workspace/src/` (host-only drafts).
2. Workspace markdown files (SOUL.md, AGENTS.md, etc.) defining agent
   behavior were mounted into the container but not under version control.
3. Memory-derived architectural claims (e.g., per-channel persona routing)
   did not match the actual codebase, leading to wasted sprint planning
   effort.
4. The `openclaw-config/` directory is a subdirectory of the TypeScript
   repo using `git update-index --skip-worktree` for local-only edits,
   NOT a standalone git repo. Prior planning incorrectly assumed it was
   standalone.

This ADR documents what _is_, not what was planned. Future architectural
decisions reference this baseline.

---

## Decision

OpenClaw runs as a three-layer system, each with its own version-control
strategy:

1. **Compiled code** — TypeScript source at `~/Projects/OpenClaw/OpenClaw/`,
   tracked in `github.com/brickjawn/OpenClaw`. Baked into the container
   image at build time.

2. **Mounted config** — `openclaw-config/` is a subdirectory of the
   TypeScript repo using `git update-index --skip-worktree` so local
   environment-specific edits to `openclaw.json` don't propagate
   upstream. This is the existing pattern; this ADR does not change it.

3. **Mounted workspace** — `openclaw-state/workspace/` markdown files
   read by the agent at runtime. Sprint 002 Phase 0 establishes a
   **standalone git repo** at this path. Not a submodule of any other
   repo. Independent lifecycle, optionally pushed to
   `github.com/brickjawn/openclaw-workspace` for off-machine backup.

The configuration described below is canonical. Changes to any layer
require a new ADR or explicit amendment to this one.

---

## Architecture

### Volume Map

<!-- TONY: confirm/refine from Claude Code's "1. Volume map" section -->

| Host path                                      | Container path                                  | Notes                                            |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `openclaw-config/`                             | `/home/node/.openclaw-config/`                  | Config dir — only place with openclaw.json       |
| `openclaw-state/`                              | `/home/node/.openclaw-state/`                   | State dir — sessions, workspace, logs, memory    |
| `openclaw-state/home-node-openclaw/`           | `/home/node/.openclaw/`                         | node user's .openclaw (mostly empty)             |
| `openclaw-state/root-openclaw/`                | `/root/.openclaw/`                              | root's .openclaw — SHADOW WORKSPACE (drift risk) |
| `openclaw-state/root-npm/`                     | `/root/.npm/`                                   | npm cache                                        |
| `openclaw-state/root-cache/`                   | `/root/.cache/`                                 | build cache                                      |
| `openclaw-state/home-node-npm/`                | `/home/node/.npm/`                              | npm cache (node user)                            |
| `openclaw-state/home-node-cache/`              | `/home/node/.cache/`                            | build cache (node user)                          |
| `Obsidian/Master_Brain/.../state/memory`       | `/home/node/.openclaw-state/workspace/obsidian` | Read-only Obsidian vault                         |
| `Obsidian/Master_Brain/99_System/_Agent_Inbox` | `/home/node/.openclaw-state/workspace/inbox`    | Writable inbox                                   |
| `/run/user/1000/openclaw-wol.sock`             | `/tmp/openclaw-wol.sock`                        | WoL relay                                        |

**Notable absence:** No `/home/node/workspace` mount. The canonical
workspace path expected by some documentation is not in use; the actual
workspace lives at `/home/node/.openclaw-state/workspace/`.

### Authoritative Environment

```
OPENCLAW_CONFIG_PATH   = /home/node/.openclaw-config/openclaw.json
OPENCLAW_STATE_DIR     = /home/node/.openclaw-state
HOME                   = /root            # process runs as root
NODE_ENV               = production
NODE_OPTIONS           = --max-old-space-size=3072
OPENCLAW_GATEWAY_TOKEN = <redacted, in openclaw-gateway.env>
```

### Source of Truth Chain

- **Container image:** `localhost/openclaw:local` (rebuilt from
  `~/Projects/OpenClaw/OpenClaw/` Containerfile)
- **Source repo:** `github.com/brickjawn/OpenClaw`
- **Config:** `openclaw-config/` subdir of OpenClaw repo, with
  `--skip-worktree` for local edits to `openclaw.json`
- **Workspace repo:** `openclaw-state/workspace/` — NEW standalone repo
  established by Sprint 002 Phase 0, optionally pushed to
  `github.com/brickjawn/openclaw-workspace`
- **Systemd unit:** `~/.config/containers/systemd/openclaw-gateway.container`
  (Quadlet, rootless Podman)

---

## Configuration Inventory

### openclaw.json (Discord routing — partial)

<!-- TONY: confirm channel IDs from Claude Code's output -->

| Channel name | Channel ID          | enabled | requireMention |
| ------------ | ------------------- | ------- | -------------- |
| ask-cto      | 1489710560286085240 | true    | true           |
| cto-feed     | 1489710603277828216 | true    | false          |

- **Guild:** `883408342251352094`
- **DM policy:** `allowlist`, `allowFrom: ["759394375481557033"]`
- **Mention patterns:** `\bOpenClaw\b`, `\bMasterBrain\b`
- **Globally denied tools:** `exec`, `gateway`, `nodes`, `browser`,
  `sessions_spawn`, `subagents`, `sessions_send`
- **Command owner:** not configured (privileged slash commands unavailable)

### Model routing

- **Primary:** `openrouter/owl-alpha`
- **Fallback chain:** 5 alternatives (OpenRouter free tier + Ollama local
  on CachyOmen `10.0.0.2:11434`)
- **Memory search:** configured for `bge-m3:latest` on `10.0.0.2:11434`
  with RRF hybrid fusion — **NOT ACTIVE** (no plugin registered;
  deployment pending on `feat/memory-rrf-fusion` branch; architecture
  documented in ADR-0001)

### Workspace files (canonical)

Located at `openclaw-state/workspace/` (host) and
`/home/node/.openclaw-state/workspace/` (container). All read by the
agent at runtime via tool calls. As of baseline capture:

- `SOUL.md` — identity and tone (single voice across all channels)
- `AGENTS.md` — tools, permissions, security rules
- `USER.md` — user preferences/background
- `MEMORY.md` — long-term memory store
- `BOOTSTRAP.md` — startup/runbook tasks
- `IDENTITY.md` — agent self-description
- `SECURITY.md` — security posture
- `HEARTBEAT.md` — heartbeat config/state
- `TOOLS.md` — tool catalog
- `CRON_SETUP.md` — scheduled tasks
- `active_context.md` — current session state
- `memory/YYYY-MM-DD.md` — session logs (per-day)
- `skills/planner/`, `skills/validator/` — skill modules
- `bin/wol-cachyomen.sh` — Wake-on-LAN script
- `scripts/daily_tech_news.py` — scheduled script
- `obsidian/` — read-only mount of Master_Brain
- `inbox/` — writable Agent_Inbox mount

---

## Known Defects (captured at baseline, not resolved by this ADR)

### CRITICAL — Dual state directories

The container process runs as root (`HOME=/root`), but
`OPENCLAW_STATE_DIR=/home/node/.openclaw-state`. The mount at
`openclaw-state/root-openclaw/` exposes a _shadow workspace_ containing
its own SOUL.md, AGENTS.md, BOOTSTRAP.md — potentially diverged from
the primary workspace. This is the #1 drift vector.

**Disposition:** Deferred to `sprint-002-followups.md`. Audit shadow
workspace contents and consolidate or remove.

### CRITICAL — ENOENT on openclaw.json

Agent tool calls probe for openclaw.json at non-existent paths:

- `/home/node/.openclaw-state/openclaw.json` (state dir, not config dir)
- `/home/croc/.openclaw/openclaw.json` (host path, not mounted)

**Root cause:** The embedded agent does not know `OPENCLAW_CONFIG_PATH`
and guesses standard paths.

**Disposition:** Fix in Sprint 002 (Phase 1) — add correct path to
AGENTS.md or BOOTSTRAP.md so the agent has authoritative reference.

### MEDIUM — Memory plugin mismatch

`openclaw.json` configures `memorySearch` with `bge-m3:latest` on
`10.0.0.2`, but no active memory plugin is registered. The RRF/memory
work on `feat/memory-rrf-fusion` is not deployed to the running image.

**Disposition:** Separate work track. See ADR-0001 for architecture.

### MEDIUM — Session state debris

2/5 recent sessions missing transcripts; 8 orphan `.jsonl` files.

**Disposition:** Not sprint-blocking. Cleanup script TBD.

### MEDIUM — pdf-tool heartbeat blocking

`openclaw-tools:pdf-tool` initializes on every 30-minute heartbeat tick,
blocking the Node.js event loop for ~2s (confirmed at 2042-2050ms during
Sprint 002 Phase 0 pre-flight). Causes recurring `event_loop_delay`
warnings.

**Disposition:** Investigate in Sprint 002 follow-on phase. Likely fix
is lazy module-level caching so init runs once per process lifetime.

### LOW — Command owner not set

`commands.ownerAllowFrom` is empty. Discord user `759394375481557033`
is in `allowFrom` but not as command owner — privileged slash commands
unavailable.

**Disposition:** Configure when slash commands are needed.

### LOW — Gateway bound to LAN

Doctor recommends loopback + tunnel. Acceptable for homelab; flagged.

---

## Ghost Paths (host-only, no runtime effect)

The following files exist on host but are NOT mounted into the container.
Sprint 002 Phase 0 archives them.

| Path                                                                | Status                    | Action                                        |
| ------------------------------------------------------------------- | ------------------------- | --------------------------------------------- |
| `~/.openclaw/workspace/src/dispatcher.js`                           | Host-only, not mounted    | Archive to `~/.openclaw/.archive/sprint-002/` |
| `~/.openclaw/workspace/src/prompts/systemPrompts.js`                | Host-only, not mounted    | Archive same                                  |
| `openclaw-state/root-openclaw/workspace/{SOUL,AGENTS,BOOTSTRAP}.md` | Shadow copies, drift risk | Audit vs. primary (deferred)                  |

---

## Consequences

### Positive

- Future drift detectable via diff against this baseline.
- Workspace markdown brought under version control as a standalone repo
  (Sprint 002 Phase 0).
- Ghost files removed from active host paths.
- Three-layer architecture explicitly documented, with each layer's
  version-control strategy made explicit.
- Cross-reference to ADR-0001 establishes how this baseline relates to
  the in-progress memory architecture.

### Negative

- Three separate git repos to track (OpenClaw code, workspace, plus
  any future). Accepted as tradeoff for clean lifecycle separation
  over single-repo simplicity.
- Dual state directory issue documented but not resolved by this ADR.
- pdf-tool heartbeat blocking documented but not resolved by this ADR.
- The `--skip-worktree` pattern on `openclaw-config/openclaw.json`
  remains in place; this ADR neither endorses nor changes it.

### Neutral

- Memory plugin (RRF) work proceeds on `feat/memory-rrf-fusion`;
  deployment is a separate decision documented in ADR-0001.

---

## Open Questions

1. Should the dual state directory issue be fixed by changing the
   container's `HOME` to `/home/node`, or by removing the root-mapped
   volumes entirely?
2. Should the `--skip-worktree` pattern on `openclaw-config/` be
   replaced with a standalone repo at some point, or is the current
   pattern stable long-term?
3. Is the agent's `openclaw.json` probe behavior fixable purely via
   AGENTS.md update, or does the embedded agent need a code-level
   environment-aware path resolver?

---

## References

- ADR-0001: hybrid-routing-and-rrf-memory (memory architecture for the
  NOT ACTIVE memorySearch configuration documented above)
- Sprint 002 Phase 0 init prompt: `~/.openclaw/sprints/sprint-002-phase-0.md`
- OpenClaw source repo: `github.com/brickjawn/OpenClaw`
- Master_Brain infra topology: `Master_Brain/infra_topology.md` (needs
  reconciliation with this ADR)
