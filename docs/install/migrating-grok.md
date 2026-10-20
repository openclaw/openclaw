---
summary: "Migrate Grok Bot agents and configuration into OpenClaw"
read_when:
  - You want to move your Grok Bot setup into OpenClaw
  - You have a Grok Bot recipe or marketplace URL to import
title: "Migrating from Grok Bot"
---

The bundled Grok Bot migration provider performs a **one-time migration**. It uses
the same preview, backup, conflict handling, and report workflow as the Hermes
provider. It does not synchronize later changes with Grok.

## Preview and import

On the computer where you use Grok Bot:

```bash
openclaw migrate grok --dry-run
openclaw migrate apply grok
```

The default source combines local Grok Bot settings with authenticated cloud
reads of your owned bots. The local roster is a discovery cache; it does not
contain complete bot instructions, skills, or memory. Planning may request macOS
Keychain access to read the Grok sign-in credential. This source login is separate
from credential migration: this provider does not copy credentials into OpenClaw.

Like Hermes, onboarding imports into a fresh setup; the standalone migration CLI
also supports existing installations:

```bash
openclaw onboard --import-from grok
openclaw migrate apply grok --from ~/exports/grok --yes
```

Standalone apply requires offline access to the selected OpenClaw state and
creates a verified backup. Review conflicts before using `--overwrite`. During
onboarding, primary workspace/config changes are staged; additional agents,
and scheduled jobs are created after promotion. Failed
deferred steps can be retried without duplicating completed agents or jobs.

## Source choices

Use `--from` with:

- A Grok Bot application data directory, normally
  `~/Library/Application Support/Grok Bot` on macOS. Local preferences may also
  live in `~/.grokbot/settings.json`.
- `live`, for an authenticated account read without requiring a local roster.
- An exported Grok Bot recipe JSON file.
- A marketplace or share URL, such as
  `https://x.ai/bot/marketplace/bots/stalk-bot`.
- A directory containing `grok-migration.json`, for an offline account snapshot.

Recipes and marketplace URLs describe one bot. They do not include the owner's
account settings or connected credentials. The report distinguishes missing
sections from sections that were exported and are empty.

## What transfers

| Grok data                  | OpenClaw result                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Owned agents               | Native agents with stable IDs; the verified Grok primary agent maps to the selected/default OpenClaw agent            |
| Names and icons            | Workspace identity plus downloaded custom icons or rendered Grok shape/color avatars                                  |
| Instructions and skills    | Full source text in `SOUL.md` and workspace skills                                                                    |
| Complete exported memory   | Appended to `MEMORY.md`, preserving existing memory and avoiding duplicate import blocks                              |
| User timezone              | `agents.defaults.userTimezone`                                                                                        |
| Compatible MCP connections | Native MCP configuration with supported tool restrictions, initially disabled pending scope and permission review     |
| Supported cron automations | Native isolated agent jobs with the source schedule and timezone, initially disabled pending tool and delivery review |

Private cloud memory is not requested because complete export support has not
been established. Only memory explicitly included in a complete recipe or
snapshot section is appended to `MEMORY.md`. Missing or partial memory is skipped
and reported; an older saved plan cannot bypass this check.

Supported cron schedules are imported disabled because Grok's tool permission
and delivery rules do not have a verified native equivalent. The report retains
their original enabled state. Review native permissions and delivery before
enabling them. Event triggers, unsupported delivery behavior, and unresolved
plugin dependencies remain manual-review items. Original automation and
integration definitions are retained in the report's source archive with
credential values redacted.

Grok plugin IDs are not OpenClaw package names. The report and each imported
agent's `GROK-IMPORT.md` include curated setup guidance for these known IDs:

| Grok integration        | OpenClaw setup path                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| AgentMail               | Official `clawhub:@agentmail/agentmail` plugin, including its CLI-backed skill |
| X                       | Bundled `xurl` skill for authenticated reads/search                            |
| Gmail and Google Sheets | Bundled `gog` skill, with the corresponding Google authorization               |
| Slack                   | Bundled Slack integration for optional report delivery                         |
| Salesforce              | Vendor's read-only SObject MCP; organization and OAuth setup remain manual     |

These are capability matches, not drop-in Grok tool implementations. No packages
are installed automatically or guessed from display names. Follow the destination
skill/tool schema: Grok connect cards, secret requests, and operation names may
not exist in OpenClaw. Retain optional/fallback choices, reconnect selected
services, and verify their tools before enabling dependent routines.

Grok's
computer-use model and tool permission policies are reported for review instead
of guessed model or permission mappings. Sessions, account UI preferences, and
cloud vault passwords are not imported as active OpenClaw state.

## Credentials

Credentials are not copied, even with `--include-secrets`. The provider does not
decrypt local user secrets, read sibling `secrets.json` values, fetch unredacted
MCP credentials, or transfer OAuth grants. Credential-bearing actions from older
saved plans are skipped. Use the native provider or integration setup to sign in.
Grok sign-in tokens may still be needed to read source definitions; they are never
imported as model API keys.

Imported MCP connections contain supported non-secret connection fields and
remain disabled until their authentication, agent scope, and tool permissions
are configured. Grok selects connections per bot, while native server definitions
are shared. The report preserves the source enabled state and lists omitted
credential fields.

## Offline account snapshots

An offline snapshot is an import artifact, not an OpenClaw runtime config file.
Its envelope is:

```json
{
  "format": "grok-migration",
  "version": 1,
  "mainAgentId": "researcher",
  "settings": { "userTimeZoneOverride": "America/Los_Angeles" },
  "agents": [
    {
      "id": "researcher",
      "profile": { "name": "Researcher", "description": "Cite your sources." },
      "memory": [],
      "skills": [],
      "routines": [],
      "plugins": []
    }
  ],
  "mcpConfig": { "mcpServers": {} },
  "credentialNames": []
}
```

Agent content uses the Grok recipe shape. Omit unavailable arrays instead of
replacing them with empty arrays. Optional `automations` contains original Grok
automation records. Optional `credentialNames` supplies metadata for manual setup
reminders only; credential values are not imported.

Snapshots exported from a partial account read can retain completeness using
`sourceStatus` entries such as `"memory": { "status": "partial", "reason": "Only memory facts were available." }`.
Top-level entries describe `settings`, `agents`, and `mcpServers`; each agent can
describe `memory`, `skills`, `automations`, and `plugins`. Optional `sourceIssues`
retains source warnings. Agent `avatarImage` accepts validated raster bytes as
`{ "base64": "...", "extension": "png" }` (also `jpg`, `gif`, and `webp`, up to
1 MiB). Optional `mcpMetadata` maps server names to original `instructions` and
`disabledTools`. These fields preserve source completeness without upgrading partial sections to
complete ones. Partial memory sections are skipped.

With multiple destination agents, pass `--agent <id>` to select the primary
import destination, including when repeating a migration that created additional
agents. A saved onboarding continuation retains its reviewed primary destination.

After migration, review the report, select a usable OpenClaw model, reconnect
manual integrations, and test the imported agents before retiring Grok Bot.
