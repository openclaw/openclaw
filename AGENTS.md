# Repository Guidelines

Repo: https://github.com/dna/dna

## Quick Reference

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Build | `pnpm build` |
| Test | `pnpm test` |
| Lint | `pnpm lint` |
| Format | `pnpm format` |
| Run CLI | `pnpm dna ...` |
| Commit | `scripts/committer "<msg>" <file...>` |

## Core Rules

1. **TypeScript (ESM)** — Strict typing, avoid `any`
2. **Run lint before commits** — `pnpm lint`
3. **Verify in code** — High-confidence answers only
4. **Never edit node_modules** — Updates overwrite
5. **Node 22+** — Prefer Bun for TS execution

## GitHub Rules

- Use literal multiline strings or `-F - <<'EOF'` for newlines in comments
- Never embed `\\n`

## Detailed Guides

| Topic | Location |
|-------|----------|
| Repo Structure | `docs/contributing/repo-structure.md` |
| Build & Dev Commands | `docs/contributing/build-commands.md` |
| Coding Style | `docs/contributing/coding-style.md` |
| Testing | `docs/contributing/testing.md` |
| PR Workflow | `docs/contributing/pr-workflow.md` |
| Docs Linking | `docs/contributing/docs-linking.md` |
| VM Operations | `docs/contributing/vm-ops.md` |
| Agent Notes | `docs/contributing/agent-notes.md` |
| Security & Config | `docs/contributing/security.md` |

## Multi-Agent Safety

- Do NOT `git stash` / `git worktree` / switch branches unless requested
- When "commit": scope to your changes only
- Focus on your edits; brief note if other files present

## Release

- Read `docs/reference/RELEASING.md` before release work
- Do NOT change versions without explicit consent
- macOS: `docs/platforms/mac/release.md`

## Troubleshooting

```bash
dna doctor  # Rebrand/migration issues, legacy config warnings
```

See `docs/gateway/doctor.md`
