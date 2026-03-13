## Remaining deployment-variable items in stable boilerplate

These items appear in the stable boilerplate (early in prompt, before workspace files).
When they change, the entire prompt is invalidated. They change RARELY.
Fix pattern: move each from stable boilerplate to dynamic tail (before modelAliasLines).
Each fix requires: init_experiment for the scenario + code change + benchmark update.

- **ownerNumbers** (position ~3,107, 12.5% stable when changed): appears in `## Authorized Senders` section. Changes when user adds/removes authorized senders (e.g., new device setup, adding family to allowlist). Fix: move `buildUserIdentitySection(ownerLine, isMinimal)` injection to dynamic tail before modelAliasLines.

- **docsPath** (position ~3,096, 12.4% stable when changed): appears in `## Documentation` section. Changes when OpenClaw updates and docs location changes. VERY RARELY changes. Fix: move `buildDocsSection` injection to dynamic tail before modelAliasLines.

- **sandboxInfo** (position ~3,061, 12.3% stable when changed): appears in `## Sandbox` section. Changes when sandbox mode is toggled. ESSENTIALLY NEVER changes after initial setup. Fix: move `sandboxInfo` section injection to dynamic tail before modelAliasLines.

- **toolNames** (position ~338, 1.4% stable when changed): appears in `## Tooling` section and potentially elsewhere. Changes when new channel plugins are installed. COMPLEX fix — toolNames are woven through multiple sections (messaging, workspace, etc.). Would require significant refactoring to move tool listing to dynamic tail.

## Build-time improvements (no primary metric impact)

- Cross-session mtime-gated bootstrap cache: track file mtimes between sessions, only re-read files that actually changed. Reduces build time.

- Skills hash-gated regeneration: cache the skills prompt by content hash of all SKILL.md files; only regenerate when a skill file changes. Build time improvement.

## Architecture ideas

- Separate AGENTS.md into base (stable global protocol) + project overlay (frequent per-project notes). User-facing design change. Would push AGENTS.md base into stable prefix.
