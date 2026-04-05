# Mullusi Platform — Claude Code Instructions

## CRITICAL: Git Rules
- NEVER open PRs against openclaw/openclaw (upstream)
- NEVER push to upstream
- All work stays on tamirat-wubie/mullusi-platform
- upstream remote is READ-ONLY (for syncing channel fixes only)
- All PRs go to origin (tamirat-wubie/mullusi-platform) only

## Branding Rules
- NEVER use "artificial intelligence" — always use "symbolic intelligence"
- NEVER modify channel adapters except for branding
- ALWAYS retain the MIT LICENSE with Peter Steinberger's original copyright
- Mfidel atomicity — no fidel decomposition, no Unicode normalization, no GPT-style Amharic decomposition
- All state mutations must be hash-chain logged — no silent writes
- Keep diffs minimal — do not rewrite files unnecessarily

## Commands
```bash
COREPACK_ENABLE_STRICT=0 pnpm install   # Install dependencies
COREPACK_ENABLE_STRICT=0 pnpm build     # Build dist/
COREPACK_ENABLE_STRICT=0 pnpm test      # Run tests
COREPACK_ENABLE_STRICT=0 pnpm lint      # Lint check
```

## Architecture
- Entry point: mullusi.mjs
- Config dir: ~/.mullusi/
- Default port: 18790
- Plugin manifests: mullusi.plugin.json
- npm dependency @mariozechner/pi-agent-core kept as-is (external package)
- Windows symlink workaround in scripts/stage-bundled-plugin-runtime.mjs
