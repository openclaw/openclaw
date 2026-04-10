# SafeClaw — CLAUDE.md

## What This Is

SafeClaw is AceTeam's fork of [OpenClaw](https://github.com/openclaw/openclaw) that adds AEP (Agentic Execution Protocol) safety and governance to every LLM call. The goal is to get these changes **merged upstream** into OpenClaw, not to maintain a permanent fork.

## Fork Strategy

This repo is a GitHub fork of `openclaw/openclaw`. We keep our SafeClaw commits rebased on top of upstream `main` so that:

1. We can open clean PRs against `openclaw/openclaw` at any time
2. We stay current with upstream features and fixes
3. The diff between our fork and upstream is always just our SafeClaw additions

**Never diverge from upstream.** If upstream refactors something we touch, adapt our code to match their new pattern — don't preserve the old pattern.

### Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `git@github.com:aceteam-ai/safeclaw.git` | Our fork |
| `upstream` | `git@github.com:openclaw/openclaw.git` | OpenClaw source |

### Syncing with Upstream

```bash
git fetch upstream
git rebase upstream/main
# Resolve any conflicts — always adapt our code to upstream's patterns
git push --force origin main
```

Force-push is expected and safe here — this fork's `main` is always a rebase on top of upstream.

### Our Changes (What We Add to OpenClaw)

All SafeClaw additions fall into these categories:

**Core integration (2 files patched):**
- `src/agents/pi-embedded-runner/extra-params.ts` — import + call `createAepHeadersWrapper` in `applyPostPluginStreamWrappers`
- `src/plugin-sdk/provider-stream.ts` — re-export `createAepHeadersWrapper`

**New files (ours entirely):**
- `src/agents/pi-embedded-runner/aep-stream-wrapper.ts` — the AEP governance header wrapper
- `src/agents/pi-embedded-runner/aep-stream-wrapper.test.ts` — tests
- `extensions/aep-safety/` — OpenClaw dashboard extension showing AEP safety status
- `skills/aep-safety/SKILL.md` — agent skill for AEP safety awareness
- `docker-compose.safe.yml` — compose overlay that adds AEP proxy sidecar
- `install.sh` — one-step SafeClaw installer
- `SAFECLAW.md` — safety documentation
- `README.md` — SafeClaw README (original preserved as `OPENCLAW-README.md`)

### Opening Upstream PRs

When ready to contribute changes back to OpenClaw, split into logical PRs:

1. **AEP governance headers** — `aep-stream-wrapper.ts`, the 2 patched files, tests. This is the core value prop.
2. **AEP safety skill** — `skills/aep-safety/`
3. **AEP dashboard extension** — `extensions/aep-safety/`
4. **Docker compose safety overlay** — `docker-compose.safe.yml`

The docs changes (README, SAFECLAW.md, install.sh) are SafeClaw-specific and don't go upstream.

### Conflict Resolution Principles

When rebasing and conflicts arise:

- **modify/delete on our new files**: always keep our version (`git add <file>`)
- **content conflicts in patched files**: take upstream's version, then re-apply our minimal addition adapted to their new code patterns
- **README conflicts**: take our version (`git checkout --theirs README.md`)

## Development

This is an OpenClaw codebase. See OpenClaw's docs for build/test commands. The key ones:

```bash
pnpm install          # Install deps
pnpm build            # Build
pnpm test             # Run tests
```

**Note:** OpenClaw's pre-commit hooks require `oxlint`. If you don't have it installed, use `--no-verify` for SafeClaw-specific commits (not ideal, but acceptable since our changes are minimal and we test separately).

## What This Is NOT

- This is **not** a standalone product. It's a contribution pipeline to OpenClaw.
- This is **not** an overlay repo. The full OpenClaw codebase lives here as a proper fork.
- Do **not** extract SafeClaw files into a separate repo. The fork relationship enables upstream PRs.
- Do **not** let the fork fall thousands of commits behind. Rebase regularly (at least before any workshop or PR push).
