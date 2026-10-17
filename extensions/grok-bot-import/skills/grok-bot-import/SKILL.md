---
name: grok-bot-import
description: Import Grok Bots into OpenClaw as Claw agents. Use when the user says “import all my Grok bots,” provides a Grok Bot share/marketplace URL, or gives a Grok recipe JSON package.
---

# Import Grok Bots

Use the `grok-bot` plugin CLI to retrieve complete recipes, convert them to native Claws, and install ordinary agents. A request to import the user's bots authorizes that import; preserve the requested selection.

## Choose the source

- Recipe JSON: use the file directly. This is offline and needs no Grok account.
- Share or marketplace URL: the CLI resolves the full template through the signed-in Grok account. Public marketplace descriptions are incomplete and are never a substitute for missing skill bodies.
- All bots: discover local identity metadata with `openclaw grok-bot list --json`, then use `--all`. Available hosted bot contents are retrieved through the signed-in account. The local roster and cached chats are not full bot exports. Before importing, explain that Grok does not expose complete owned-bot memories or original integration requirements through these read APIs. The result is explicitly partial; use complete recipe exports when the user requires full fidelity.

Run source retrieval on the machine with Grok Bot installed and signed in. On macOS, the CLI lazily uses that app's active account and Keychain; an approval/unlock may be required. Other platforms can use `GROK_BOT_ACCESS_TOKEN` supplied through the process environment. Keep credentials out of command arguments, logs, and chat.

## Convert and install

Choose a new output directory for each operation. Keep the converted package as a reviewable user artifact.

```sh
openclaw grok-bot import /path/to/recipe.json --out /path/to/new-claw --install --json
openclaw grok-bot import 'https://x.ai/bot/marketplace/bots/stalk-bot' --out /path/to/stalk-claw --install --json
openclaw grok-bot import --all --out /path/to/new-import-directory --install --json
```

`--install` uses the running gateway's native Claws plan/apply flow, with its existing Labs setting, admin authorization, and installation checks. The output directory must be on the gateway machine. If source retrieval is on another machine, first convert without `--install`, transfer only the resulting Claw package using the user's authorized file transport, and run `openclaw grok-bot install /path/to/package --json` on the gateway machine. Preserve the Grok source app's files.

Read every result, including `conversion.completeness` and `conversion.warnings`. For partial sources, report that memories and complete original integration requirements were unavailable; do not describe zero imported memories as an empty source memory. A failed bot retains its error and does not stop the other selected bots. Report failures by bot name and next action; never count a converted package as an installed agent. For an installation error, inspect the current agents before retrying because a partial agent may exist.

## Verify and set up

For each installed agent, verify the returned agent ID, imported name/avatar, and workspace skill files. Start its setup conversation when the user requests use of the bot. Its `BOOTSTRAP.md` points to imported setup instructions and `GROK-IMPORT.md`.

Imported routines are retained as files and are not scheduled. Preserve their source cadence and content; ask for missing timezone/delivery choices before enabling a requested routine. Grok plugin IDs are not OpenClaw package names. Resolve the listed integration requirements to available OpenClaw integrations and verify connections before claiming their skills work. Report unsupported capabilities explicitly.

Finish with installed/failed counts, names, completeness and missing-source warnings, available chat links, and any integration or routine setup still required.
