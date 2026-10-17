# Grok Bot Import

Converts complete Grok Bot recipes into portable Claw packages and optionally adds them as ordinary OpenClaw agents. The bundled plugin makes `openclaw grok-bot` and its conversational import skill available by default; account access only happens when explicitly requested.

```sh
openclaw grok-bot list --json
openclaw grok-bot import ./recipe.json --out ./research-claw --install --json
openclaw grok-bot import https://x.ai/bot/marketplace/bots/stalk-bot --out ./stalk-claw --install --json
openclaw grok-bot import --all --out ./my-grok-claws --install --json
```

Omit `--install` to produce Claw packages only. Installation requires Claws enabled in Labs and an admin-authorized connection to a running gateway. Run installation on the gateway machine using its local gateway configuration. Transfer converted packages from another machine, then use `openclaw grok-bot install ./package --json`. Existing destination files are never overwritten.

## Sources and authentication

A Grok recipe JSON contains `profile`, `memory`, `skills`, `routines`, `plugins`, and optionally `gettingStarted`. Local recipes work offline. Shared and marketplace URLs resolve Grok's authenticated recipe download; marketplace skill summaries are never imported as full skill bodies.

For your own bots, local discovery reads only Grok's roster cache. `--all` uses the active signed-in account's hosted roster and retrieves the available profile instructions, avatar, full skills, routines, and installed-plugin metadata. `list --online` previews that selection.

Owned-bot imports are marked `completeness: "partial"`: Grok's available read APIs do not expose their complete memories or original integration requirements. The importer records these omissions in its result and the Claw's setup notes; a zero imported-memory count does not mean the source bot has no memories. Complete recipe files and shared/marketplace recipe URLs preserve their supplied memories and requirements. Source bots remain unchanged.

On macOS, the plugin can reuse the active Grok Bot account in that application's local storage through the login Keychain. Access is lazy, occurs only during an explicit import/list operation, and may request Keychain approval. `GROK_BOT_ACCESS_TOKEN` in the process environment takes precedence and supports other platforms. Tokens remain in memory; the importer does not save or print credentials or read source conversation caches. Grok's app/API formats are not a published compatibility contract and can change; incompatible responses fail visibly.

## Preserved content

- Profile instructions become the Claw's instructions.
- Memory becomes `MEMORY.md`.
- Full skill bodies become workspace skills.
- Source names become the agent name and chat identity. Supported avatar shape/color becomes a managed SVG; hosted custom photos retain their verified image bytes.
- Getting-started instructions are connected through `BOOTSTRAP.md`.
- Routine definitions and plugin requirements are retained in workspace files and summarized in the import result.

Routines are not scheduled automatically. Review cadence, timezone, delivery and permissions before enabling them. Grok plugin IDs are retained as source metadata; connect equivalent OpenClaw integrations separately. Account secrets, conversations and Grok-specific executable extensions are not migrated.

Each selected bot has its own success/failure result. Bulk imports with failed bots return a nonzero exit code while retaining successfully converted packages and installed agents. Inspect existing agents before retrying an installation that failed partway through.
