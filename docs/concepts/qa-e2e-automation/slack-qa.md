---
doc-schema-version: 1
summary: "The Slack QA lane and the workspace, app, and scope provisioning it needs."
read_when:
  - You are running the Slack QA lane
  - You are provisioning a Slack workspace for QA
title: "Slack QA"
---

## Slack QA

```bash
pnpm openclaw qa slack
```

Targets one real private Slack channel with two distinct bots: a driver bot
controlled by the harness and a SUT bot started by the child OpenClaw gateway
through the bundled Slack plugin.

Required env when `--credential-source env`:

- `OPENCLAW_QA_SLACK_CHANNEL_ID`
- `OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_APP_TOKEN`

Optional:

- `OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR` enables visual approval
  checkpoints for Mantis. The adapter writes `<scenario>.pending.json` and
  `<scenario>.resolved.json`, then waits for matching `.ack.json` files.
- `OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS` overrides the checkpoint
  acknowledgement timeout. The default is `120000`.

Canonical YAML scenarios exposed through the Slack live adapter:

- `thread-follow-up`
- `thread-isolation`

Slack YAML module scenarios (`qa/scenarios/channels/slack-*.yaml`):

- `slack-canary`
- `slack-mention-gating`
- `slack-mpim-app-mention-dedupe` - opens a real C-prefixed group DM, verifies
  exactly one SUT reply after message/app-mention twin delivery, confirms a
  native threaded follow-up can recall that bot reply, then closes the MPIM.
- `slack-allowlist-block`
- `slack-channel-disabled-warning` - opt-in real-Slack probe that confirms a
  configured disabled channel emits a structured warning without replying.
- `slack-top-level-reply-shape`
- `slack-restart-resume`
- `slack-progress-commentary-true`, `slack-progress-commentary-false`,
  `slack-progress-commentary-omitted`, and
  `slack-progress-commentary-verbose-dedupe` / `slack-progress-commentary-verbose-full` - opt-in real-Slack probes for
  independent commentary/tool-progress controls, the omitted-key legacy
  default, and single-delivery behavior for durable verbose progress. The `on`
  probe requires a safe Exec summary without command text or output; the `full`
  probe requires the exact stdout marker in a separate tool-output message.
  Both use the same command and require one commentary identity separate from
  the final answer. Full verbosity allows the runtime's command metadata and
  one separate start summary, while requiring a unique completed-output identity.
  Slack may strip command-summary headers during delivery, so the exact output
  line, not a tool label, identifies completed output.
  Failures retain bounded
  presentation facts without raw Slack messages or platform identities,
  including marker formatting and `sleep` summaries missing the command marker.
- `slack-reaction-glyph-native` - opt-in live message-tool reaction scenario.
  Instructs the agent to pass the exact `✅` glyph and confirms Slack stored
  `white_check_mark` for the SUT bot on the target message.
- `slack-chart-presentation-native` - opt-in portable chart scenario that
  verifies the native `data_visualization` block and exact accessible text.
- `slack-table-presentation-native` - opt-in portable table scenario that
  verifies the native `data_table` block, exact rows, and accessible text.
- `slack-table-invalid-blocks-fallback` - opt-in direct-transport scenario
  that sends a structurally readable over-limit raw table with 101 data rows
  plus its header through the
  production Slack send path, proves Slack itself returns `invalid_blocks`,
  and verifies the stored formatting-disabled fallback is complete and has no
  native data block. Scenario details keep only safe error-code, count, and
  boolean evidence.
- `slack-approval-exec-native` - opt-in native Slack exec approval scenario.
  Requests an exec approval through the gateway, verifies the Slack message
  has native approval buttons, resolves it, and verifies the resolved Slack
  update.
- `slack-approval-plugin-native` - opt-in native Slack plugin approval
  scenario. Enables exec and plugin approval forwarding together so plugin
  events are not suppressed by exec approval routing, then verifies the same
  pending/resolved native Slack UI path.
- `slack-codex-approval-exec-native` - opt-in Codex Guardian command approval
  scenario. Enables the Codex plugin in Guardian mode, routes a
  Slack-originated Gateway agent turn through the Codex app-server harness,
  waits for the native Slack plugin approval prompt for
  `codex`, resolves it, and verifies the Codex turn
  finishes with the expected command-output and assistant markers.
- `slack-codex-approval-plugin-native` - opt-in Codex Guardian file approval
  scenario. Uses an outside-workspace `apply_patch` instruction so Codex emits
  the app-server file-change approval route, then verifies the same native
  Slack pending/resolved approval path, final assistant marker, and exact file
  contents before cleanup.

The Codex approval scenarios require an `openai/*` or `codex/*` `--model`, the
normal live model credentials, and Codex auth or API-key auth accepted by the Codex plugin.
The scenario details include the Codex app-server method, selected Codex model
key, final Codex turn status, and operation-marker verification alongside the
redacted Slack approval metadata.

Output artifacts:

- `qa-suite-report.md`
- `qa-suite-summary.json`
- `qa-evidence.json` - evidence entries for the live transport checks.
- `approval-checkpoints/` - only when Mantis sets
  `OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR`; contains checkpoint JSON,
  acknowledgement JSON, and pending/resolved screenshots.

### Setting up the Slack workspace

The lane needs two distinct Slack apps in one workspace, plus a channel both
bots are members of:

- `channelId` - the `Cxxxxxxxxxx` id of a channel both bots have been
  invited to. Use a dedicated channel; the lane posts on every run.
- `driverBotToken` - bot token (`xoxb-...`) of the **Driver** app.
- `sutBotToken` - bot token (`xoxb-...`) of the **SUT** app, which must be a
  separate Slack app from the driver so its bot user id is distinct.
- `sutAppToken` - app-level token (`xapp-...`) of the SUT app with
  `connections:write`, used by Socket Mode so the SUT app can receive events.

Prefer a Slack workspace dedicated to QA over reusing a production
workspace.

The SUT manifest below intentionally narrows the bundled Slack plugin's
production install (`extensions/slack/src/setup-shared.ts:12`) to the
permissions and events covered by the live Slack QA suite. For the
production-channel setup as users see it, see
[Slack channel quick setup](/channels/slack/setup#quick-setup); the QA Driver/SUT
pair is intentionally separate because the lane needs two distinct bot user
ids in one workspace.

**1. Create the Driver app**

Go to [api.slack.com/apps](https://api.slack.com/apps) → _Create New App_ →
_From a manifest_ → pick the QA workspace, paste the following manifest,
then _Install to Workspace_:

```json
{
  "display_information": {
    "name": "OpenClaw QA Driver",
    "description": "Test driver bot for OpenClaw QA Slack live lane"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw QA Driver",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": ["chat:write", "channels:history", "groups:history", "users:read"]
    }
  },
  "settings": {
    "socket_mode_enabled": false
  }
}
```

Copy the _Bot User OAuth Token_ (`xoxb-...`) - that becomes
`driverBotToken`. The driver only needs to post messages and identify
itself; no events, no Socket Mode.

**2. Create the SUT app**

Repeat _Create New App → From a manifest_ in the same workspace. This QA app
intentionally uses a narrower version of the bundled Slack plugin's
production manifest (`extensions/slack/src/setup-shared.ts:12`): reaction
scopes and events are omitted because the live Slack QA suite does not cover
reaction handling yet.

```json
{
  "display_information": {
    "name": "OpenClaw QA SUT",
    "description": "OpenClaw QA SUT connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw QA SUT",
      "always_online": true
    },
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "usergroups:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "channel_rename",
        "member_joined_channel",
        "member_left_channel",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

After Slack creates the app, do two things on its settings page:

- _Install to Workspace_ → copy the _Bot User OAuth Token_ → that becomes
  `sutBotToken`.
- _Basic Information → App-Level Tokens → Generate Token and Scopes_ → add
  scope `connections:write` → save → copy the `xapp-...` value → that
  becomes `sutAppToken`.

Verify the two bots have distinct user ids by calling `auth.test` on each
token. The runtime distinguishes driver and SUT by user id; reusing one app
for both will fail mention-gating immediately.

**3. Create the channel**

In the QA workspace, create a channel (e.g. `#openclaw-qa`) and invite both
bots from inside the channel:

```text
/invite @OpenClaw QA Driver
/invite @OpenClaw QA SUT
```

Copy the `Cxxxxxxxxxx` id from _channel info → About → Channel ID_ - that
becomes `channelId`. A public channel works; if you use a private channel
both apps already have `groups:history` so the harness's history reads will
still succeed.

**4. Register the credentials**

Two options. Use env vars for single-machine debugging (set the four
`OPENCLAW_QA_SLACK_*` variables and pass `--credential-source env`), or seed
the shared Convex pool so CI and other maintainers can lease them.

For the Convex pool, write the four fields to a JSON file:

```json
{
  "channelId": "Cxxxxxxxxxx",
  "driverBotToken": "xoxb-...",
  "sutBotToken": "xoxb-...",
  "sutAppToken": "xapp-..."
}
```

With `OPENCLAW_QA_CONVEX_SITE_URL` and `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER`
exported in your shell, register and verify:

```bash
pnpm openclaw qa credentials add \
  --kind slack \
  --payload-file slack-creds.json \
  --note "QA Slack pool seed"

pnpm openclaw qa credentials list --kind slack --status all --json
```

Expect `count: 1`, `status: "active"`, no `lease` field.

**5. Verify end to end**

Run the lane locally to confirm both bots can talk to each other through the
broker:

```bash
pnpm openclaw qa slack \
  --credential-source convex \
  --credential-role maintainer \
  --output-dir .artifacts/qa-e2e/slack-local
```

A green run completes in well under 30 seconds and `qa-suite-report.md`
shows both `slack-canary` and `slack-mention-gating` at status `pass`. If the
lane hangs for ~90 seconds and exits with `Convex credential pool exhausted
for kind "slack"`, either the pool is empty or every row is leased - `qa
credentials list --kind slack --status all --json` will tell you which.
