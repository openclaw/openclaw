---
name: clawhub-publish
description: "Publish OpenClaw skills to ClawHub marketplace (clawhub.ai). Use when deploying a skill for the first time, updating an existing published skill, or batch-publishing multiple skills. Triggers: '스킬 배포', 'ClawHub에 올려줘', 'publish skill', '스킬 퍼블리시', 'ClawHub publish', 'publish to marketplace', '마켓플레이스에 올려'. Handles language check (Korean → English), personal info sanitization, versioning, and clawhub CLI publish. NOT for: installing skills (use clawhub skill), skill development/creation (use skill-creator)."
---

# ClawHub Publish

## Prerequisites

- `npm i -g clawhub` installed
- `clawhub whoami` authenticated (if not: `clawhub login` via PTY + browser)
- Target skill exists under `C:\MAIBOT\skills\<skill-name>\`

## Workflow

1. **Pre-publish check** — Run `references/checklist.md` against each skill
2. **Fix issues** — English-only SKILL.md, no personal info, generic placeholders
3. **Version** — First=`1.0.0`, content fix=minor, rewrite=major, typo=patch
4. **Publish:**
   ```powershell
   cd C:\MAIBOT
   clawhub publish ./skills/<skill-name> `
     --slug <slug> --name "<Display Name>" `
     --version <X.Y.Z> --changelog "<summary>"
   ```
5. **Verify** — `clawhub whoami` + check `https://clawhub.ai/u/jini92`
6. **Update records** — `memory/marketplace-strategy.md` + Obsidian dashboard

For detailed publish procedures, see `references/publish-guide.md`.
For pre-publish quality checklist, see `references/checklist.md`.

## Slug Rules

- Lowercase + hyphens only, globally unique
- If taken: append `-mai` suffix

## Common Errors

| Error                                | Fix                                      |
| ------------------------------------ | ---------------------------------------- |
| `Not logged in`                      | `clawhub login` in PTY; open browser URL |
| `Only the owner can publish updates` | Slug conflict; add `-mai` suffix         |
| `Login session timeout (code 1)`     | Rerun `clawhub login`; keep PTY alive    |
