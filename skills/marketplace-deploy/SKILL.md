---
name: marketplace-deploy
description: "Deploy apps and plugins to marketplaces (npm, Chrome Web Store, VS Code Marketplace, Obsidian Community Plugins, PyPI, etc.). Use when publishing packages, submitting to stores, managing release artifacts, or troubleshooting marketplace submission failures. Triggers: 'publish to npm', 'marketplace deploy', 'store submission', 'publish package', '마켓플레이스 배포', '패키지 배포', '스토어 등록'. NOT for: app store (iOS/Android) deploys (use expo-appstore-deploy), ClawHub skill publishing (use clawhub-publish), internal deployments."
---

# Marketplace Deploy

Deploy packages and plugins to various marketplaces and registries.

## Supported Marketplaces

| Marketplace                | Command/Tool                       | Auth                 |
| -------------------------- | ---------------------------------- | -------------------- |
| npm                        | `npm publish`                      | `~/.npmrc` or OTP    |
| PyPI                       | `twine upload` / `python -m build` | `~/.pypirc` or token |
| Chrome Web Store           | `chrome-webstore-upload` CLI       | OAuth2               |
| VS Code Marketplace        | `vsce publish`                     | PAT token            |
| Obsidian Community Plugins | GitHub PR to obsidian-releases     | GitHub CLI           |

## Workflow

1. **Pre-flight checks** — version bump, changelog, build artifacts exist
2. **Build** — run project-specific build command
3. **Test** — run tests, lint, type-check before publish
4. **Publish** — execute marketplace-specific publish command
5. **Verify** — confirm published version matches expected
6. **Tag** — create git tag + GitHub release if applicable

## Key Rules

- Always verify version doesn't already exist on the registry before publishing
- Use OTP/2FA when required (npm: `--otp` flag)
- Never publish from dirty working tree — commit first
- For npm: see `references/npm-publish.md` for 1Password OTP flow
- For Obsidian plugins: use the `obsidian-plugin-release` skill instead

## References

- `references/npm-publish.md` — npm publish with 1Password OTP
- `references/marketplace-checklist.md` — pre-publish checklist template
