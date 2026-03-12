---
name: mai-deploy
description: >-
  MAI Universe project deployment automation across multiple platforms (Railway, EAS/Expo, ClawHub, npm/pip, GitHub Pages/Vercel).
  Guides pre-deploy checklists, deployment commands, rollback, and status checks per platform.
  Triggers: "배포해줘", "deploy", "railway up", "EAS build", "앱 배포", "스킬 배포",
  "npm publish", "배포 상태", "deploy status", "롤백", "rollback", "production 배포".
  NOT for: local dev server startup (use pnpm dev), CI/CD pipeline config editing,
  infrastructure provisioning (servers, DNS, etc.).
---

# MAI Deploy

Deployment automation for MAI Universe projects.

## Platform Matrix

| Platform                         | Target Projects             | Reference                                                      |
| -------------------------------- | --------------------------- | -------------------------------------------------------------- |
| **Railway** (web services)       | MAIOSS, MAIBEAUTY, MAISTAR7 | [references/railway.md](references/railway.md)                 |
| **EAS Build** (mobile apps)      | MAIBOTALKS, MAITUTOR        | [references/eas-mobile.md](references/eas-mobile.md)           |
| **ClawHub** (skills)             | Mnemo, bot skills           | [references/clawhub-deploy.md](references/clawhub-deploy.md)   |
| **npm/pip** (packages)           | MAIOSS                      | [references/package-publish.md](references/package-publish.md) |
| **GitHub Pages / Vercel** (docs) | MAIOSS docs, MAICON docs    | [references/static-sites.md](references/static-sites.md)       |

## Universal Pre-Deploy Checklist

1. `pnpm build` succeeds (or equivalent build command)
2. `pnpm test` passes
3. Environment variables set (check project's `deploy.json` if exists)
4. Version bumped where applicable

## Quick Commands

```powershell
# Railway
cd C:\TEST\MAI{project}; railway up

# EAS Build (all platforms)
cd C:\TEST\MAI{project}; npx eas-cli build --platform all

# ClawHub skill publish
clawhub publish skills/{skill-name}

# npm publish
cd C:\TEST\MAIOSS; npm version patch; npm publish --access public

# Deploy status check (all projects)
powershell C:\MAIBOT\scripts\deploy-check.ps1
```

## Rollback

- **Railway:** `railway rollback`
- **EAS:** rebuild previous version + submit
- **npm:** `npm unpublish <pkg>@<version>` (within 72h) or publish fix version
- **Vercel:** `vercel rollback`

Detailed per-platform guides are in the `references/` folder linked above.
