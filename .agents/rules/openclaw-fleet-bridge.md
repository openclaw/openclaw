# OpenClaw fleet bridge — task truth and handoffs

**Always apply** (mirrored from Cursor `.cursor/rules/`).

# Fleet bridge

- Task truth: `~/.openclaw/workspace/TASK_REGISTRY.json` (not stale agent TODO files alone)
- Paths: `~/.openclaw/workspace/workspace-paths.json`
- Policy: `~/.openclaw/workspace/CURSOR_VS_FLEET.md`
- Cross-agent handoffs use JSON per `PAYLOAD_STANDARDS.md` — not chat log pastes
- When Jacob completes fleet work in Cursor, update TASK_REGISTRY status

## OpenClaw offline (desk mode)

While fleet is offline, follow `docs/DOC-AUTHORITY.md`:

1. **Roadmap:** `docs/SITE-BACKLOG.md` only (done/pending + fleet reconciliation)
2. **Sessions:** append short entry to `docs/OFFLINE-DESK-LOG.md` (audit trail — no duplicate checklists)
3. Do **not** update TASK_REGISTRY from desk; fleet syncs on return
4. Deploy: `docs/DEPLOY-CHECKLIST.md`

When OpenClaw returns: read `DOC-AUTHORITY.md` → `OFFLINE-DESK-LOG.md` → reconcile `SITE-BACKLOG.md` → `TASK_REGISTRY.json`.

## Git write (Vercel + production)

- **Push / merge:** only as **`shrad3r`** (`gh auth switch -u shrad3r`)
- **Merge PRs:** `./scripts/owner-merge-pr.sh <n>` — never bare `gh pr merge` as Henri
- **Henri-ShraderWorks:** read-only on GitHub — never push or merge (except owner-authored `main` recovery push; see `docs/GIT-OWNER-POLICY.md`)
- `main` commits must be authored by **`jake@shraderworks.com`**
