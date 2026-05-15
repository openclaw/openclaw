# Upstream Update Summary: v2026.4.1 → v2026.5.16-beta.1

Goal: assess what we would incorporate by updating Polytropos from upstream v2026.4.1 to v2026.5.16-beta.1.

## How this summary was produced

- Tags compared: v2026.4.1 .. v2026.5.16-beta.1
- Directory-level diff: aggregated at depth=2 (e.g. src/plugins, src/agents, docs/polytropos)
- Merge conflict check: local dry-run merge of v2026.5.16-beta.1 into current fork main, then aborted

## Directory-level change surface (depth=2)

Top areas touched (by file-count, depth=2):

```
   1616 src/agents
    675 src/gateway
    669 src/infra
    640 src/commands
    638 src/plugins
    600 src/plugin-sdk
    502 src/auto-reply
    489 extensions/discord
    389 ui/src
    375 src/cli
    355 src/config
    347 src/channels
    324 extensions/telegram
    313 docs/zh-CN
    301 extensions/browser
    291 extensions/matrix
    262 extensions/slack
    234 extensions/whatsapp
    231 extensions/qqbot
    211 extensions/qa-lab
    186 extensions/feishu
    178 scripts/e2e
    173 vendor/a2ui
    165 src/cron
    165 extensions/msteams
    163 docs/plugins
    144 apps/android
    135 extensions/codex
    131 extensions/memory-core
    130 test/vitest
    125 test/scripts
    120 apps/macos
    111 src/secrets
    108 extensions/imessage
    101 extensions/voice-call
     99 extensions/mattermost
     95 packages/memory-host-sdk
     90 apps/ios
     89 scripts/lib
     84 src/security
```

## Changelog / release notes

TODO: summarize upstream changelog entries between v2026.4.1 and v2026.5.16-beta.1.
(We should extract the relevant section from upstream CHANGELOG / releases notes once we confirm the canonical file.)

## Merge conflict report

Dry-run merge exit code: 1

Conflicting files (if any):

```
package.json
```

## Notes / risk areas to re-verify post-merge

- plugin loading + packaging
- workflow CI changes
- release scripts
- any config schema or tool routing changes
