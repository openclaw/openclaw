# Skill Extraction From Forked Index (2026-02-19)

Source index (read-only):
- `/Users/tg/Projects/OpenClaw/awesome-openclaw-skills/README.md`

Goal:
- Identify high-value skills from the forked index and surface those not yet installed in Mission Control dashboard.

## Selected High-Value Skills

1. `github`
2. `github-pr`
3. `auto-pr-merger`
4. `conventional-commits`
5. `test-runner`
6. `debug-pro`
7. `tdd-guide`
8. `mcp-builder`
9. `docker-essentials`
10. `cloudflare`
11. `vercel-deploy`
12. `netlify`
13. `ssh-tunnel`
14. `skill-vetting`
15. `release-bump`
16. `codex-orchestration`

## Dashboard Implementation

Implemented in Skills Dashboard:
- Added curated recommendation registry at:
  - `/Users/tg/Projects/OpenClaw/openclaw-mission-control/src/lib/recommended-skills.ts`
- Added "Recommended Skills Not Yet Installed" section in:
  - `/Users/tg/Projects/OpenClaw/openclaw-mission-control/src/components/views/skills-dashboard.tsx`

Behavior:
- Compares curated skills against currently detected gateway/plugin skills.
- Shows only missing recommendations.
- Provides direct source link and install command:
  - `npx clawhub@latest install <skill-slug>`

## Notes

- No changes were made to the forked repository:
  - `/Users/tg/Projects/OpenClaw/awesome-openclaw-skills`
- The fork was used only as an extraction source for skill discovery.

