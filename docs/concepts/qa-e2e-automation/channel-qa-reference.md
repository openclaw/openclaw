---
doc-schema-version: 1
summary: "Shared CLI flags for the real-transport lanes and the Buzz, Telegram, and Discord lane reference."
read_when:
  - You are running the Buzz, Telegram, or Discord QA lane
  - You need the flags every real-transport lane accepts
title: "Channel QA reference"
---

## Buzz, Discord, Slack, Telegram, and WhatsApp QA reference

The Matrix adapter uses the disposable Docker-backed lane documented in
[Matrix live lane](/concepts/qa-e2e-automation/operator-flow#matrix-live-lane).
Buzz, Discord, Slack, Telegram, and WhatsApp run against pre-existing real
transports, so their reference lives here.

### Shared CLI flags

These lanes register through the shared QA runner CLI contract. Transport
plugins may own the registration while QA Lab remains the suite host. They
accept the same flags:

| Flag                                  | Default                                                  | Description                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scenario <id>`                     | -                                                        | Run only this scenario. Repeatable.                                                                                                                                                                                                                                                                   |
| `--output-dir <path>`                 | `<repo>/.artifacts/qa-e2e/<transport>-<timestamp>`       | Where reports, summaries, evidence, transport-specific artifacts, and the output log are written. Relative paths resolve against `--repo-root`.                                                                                                                                                       |
| `--repo-root <path>`                  | `process.cwd()`                                          | Repository root when invoking from a neutral cwd.                                                                                                                                                                                                                                                     |
| `--sut-account <id>`                  | `sut`                                                    | Temporary account id inside the QA gateway config.                                                                                                                                                                                                                                                    |
| `--provider-mode <mode>`              | `live-frontier` (Buzz: `mock-openai`)                    | `mock-openai`, `aimock`, or `live-frontier`.                                                                                                                                                                                                                                                          |
| `--model <ref>` / `--alt-model <ref>` | provider default                                         | Primary/alternate model refs.                                                                                                                                                                                                                                                                         |
| `--fast`                              | off                                                      | Provider fast mode where supported.                                                                                                                                                                                                                                                                   |
| `--credential-source <source>`        | shared environment (Buzz: `file` with a credential file) | Existing lanes use `env` or `convex`; Buzz uses a local file when `--credential-file` is set, otherwise it delegates to `OPENCLAW_QA_CREDENTIAL_SOURCE` and the shared environment source. See [Convex credential pool](/concepts/qa-e2e-automation/whatsapp-and-credentials#convex-credential-pool). |
| `--credential-role <maintainer\|ci>`  | `ci` in CI, `maintainer` otherwise                       | Role used when `--credential-source convex`.                                                                                                                                                                                                                                                          |
| `--credential-file <path>`            | -                                                        | Buzz-only JSON credential file for local runs.                                                                                                                                                                                                                                                        |
| `--allow-failures`                    | off                                                      | Write artifacts without returning a failing exit code when scenarios fail.                                                                                                                                                                                                                            |

Telegram fixes `--credential-source` to `convex`. Its Test Server userbot
credential cannot be supplied through the shared environment credential mode.

Each lane exits non-zero on any failed scenario. `--allow-failures` writes
artifacts without setting a failing exit code. Telegram also accepts
`--list-scenarios` to print available scenario ids and exit; the other lanes
do not expose that flag.

### Buzz QA

```bash
pnpm openclaw qa buzz \
  --credential-file /secure/path/buzz-qa-credentials.json
```

Targets one real Buzz room with two dedicated Nostr identities. The driver
publishes inbound room events; the SUT identity is configured in the child
OpenClaw Gateway and its outbound events are observed from the relay. The
default `mock-openai` provider proves the real Buzz transport without requiring
a model-provider credential.

Local runs use `--credential-file <path>` with a private JSON file containing
`relayUrl`, `roomId`, `driverPrivateKey`, and `sutPrivateKey`. Closed relays may
also need `driverAuthTag` and `sutAuthTag`. Relative paths resolve from
`--repo-root`. Hosted relays must use `wss://`; plaintext `ws://` is accepted
only for loopback development relays.

Both identities must be members of the dedicated room, and the SUT public key
must have the **Bot** role. A hosted closed relay may also require both public
keys to be enrolled as relay members. Use dedicated QA identities only; never
use a human owner or admin private key. Keep all private keys and authorization
values out of logs, command lines, artifacts, screenshots, and source control.

The default scenarios are:

- `channel-canary`
- `channel-mention-gating`

Each run writes `qa-suite-report.md`, `qa-suite-summary.json`, and
`qa-evidence.json` under the selected output directory. The report identifies
the real Buzz relay path but omits credential values.

### Telegram QA

```bash
pnpm openclaw qa telegram
```

Targets one shared private group on Telegram's Test Server. One Convex lease
contains the SUT bot plus one independent TDLib authorization for the QA user.
That user sends test messages and observes SUT messages and edits through one
long-lived TDLib process. The shared live group requires a mention of the leased
bot or a reply to that bot; scenarios use `@openclaw`, which the adapter replaces
with the leased bot username. Native commands are addressed to that same bot.

Required env:

- `OPENCLAW_QA_CONVEX_SITE_URL`
- `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` for the default local role, or
  `OPENCLAW_QA_CONVEX_SECRET_CI` with `--credential-role ci`

`--credential-source` defaults to `convex`; `env` is rejected. The lease owns
the Test Server group, SUT token, and restored TDLib session. The lane does not
use production Telegram credentials or Bot-to-Bot Communication Mode.

The `release` profile selects taxonomy-owned Telegram scenarios that declare
the channel, use the flow execution kind, and match the requested provider and
model lane. Explicit `--scenario` values narrow that same selection instead of
bypassing its constraints. Use `pnpm openclaw qa telegram --list-scenarios
--provider-mode mock-openai` to print the current selection with regression
refs. Supplying `--model` applies the same model constraint to listing and
execution.

`telegram-startup-getme-live` is a catalog script producer, not a live-adapter
flow. Run it through `qa suite --scenario telegram-startup-getme-live`; the
dedicated `qa telegram` command and `--list-scenarios` intentionally omit it.

Output artifacts:

- `qa-suite-report.md`
- `qa-suite-summary.json`
- `qa-evidence.json` - evidence entries for the live transport checks,
  including profile, coverage, provider, channel, artifacts, result, and RTT
  fields.

Package Telegram runs use the same Telegram credential contract. Repeated RTT
measurement is part of the normal package Telegram live lane; the RTT
distribution is folded into `qa-evidence.json` under `result.timing` for the
selected RTT check.

```bash
OPENCLAW_QA_CREDENTIAL_SOURCE=convex \
pnpm test:docker:npm-telegram-live
```

The package live wrapper leases a `kind: "telegram-test-userbot"` credential,
restores its isolated TDLib user session, and routes the SUT bot through the
Test Bot API proxy. It heartbeats the lease and releases it on shutdown. The
package wrapper defaults to 20 RTT checks of `channel-canary`, a 30s RTT
timeout, and Convex role `maintainer` outside CI. Override
`OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES`, `OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS`,
or `OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES` to tune RTT measurement without
creating a separate RTT command or Telegram-specific summary format.

### Discord QA

```bash
pnpm openclaw qa discord
```

Targets one real private Discord guild channel with two bots: a driver bot
controlled by the harness and a SUT bot started by the child OpenClaw gateway
through the bundled Discord plugin. Verifies channel mention handling, that
the SUT bot has registered the native `/help` command with Discord, and
opt-in Mantis evidence scenarios.

Required env when `--credential-source env`:

- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID` - must match the SUT bot user id
  returned by Discord (the lane fails fast otherwise).

Voice destination:

- `OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID` selects the voice/stage channel for
  `discord-voice-autojoin`; without it, the scenario picks the first visible
  voice/stage channel for the SUT bot. It is required for
  `discord-transcripts-voice-authorization` when using env credentials.

Discord YAML module scenarios (`qa/scenarios/channels/discord-*.yaml`):

- `discord-canary`
- `discord-mention-gating`
- `discord-native-help-command-registration`
- `discord-progress-draft-lifecycle` - runs a deterministic tool turn, verifies
  the final answer has no synthesized activity receipt, confirms the working
  draft is deleted after a successful final, and confirms an error final keeps
  its draft visible as diagnostic context.
- `discord-voice-autojoin` - opt-in voice scenario. Runs by itself, enables
  `channels.discord.voice.autoJoin`, and verifies the SUT bot's current
  Discord voice state is the target voice/stage channel. Convex Discord
  credentials may include optional `voiceChannelId`; otherwise the runner
  adapter discovers the first visible voice/stage channel in the guild.
- `discord-transcripts-voice-authorization` - opt-in live-model scenario. A
  real driver-bot message first proves a sender excluded from the target voice
  channel receives a visible transcript-tool denial without a join. The same
  sender is then allowlisted and must start, stop, and leave live capture. The
  scenario writes redacted JSON evidence and deletes its known Discord
  messages during cleanup. It requires an explicit `voiceChannelId` in the
  leased credential or `OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID`; it never discovers
  a room automatically. The operator must reserve a dedicated empty QA voice
  channel before running it. An explicit ID does not prove that prerequisite:
  the harness observes the SUT bot's connection, not the room's full membership.
- `discord-status-reactions-tool-only` - opt-in Mantis scenario. Runs by
  itself because it switches the SUT to always-on, tool-only guild replies
  with `messages.statusReactions.enabled=true`, then captures a REST
  reaction timeline plus HTML/PNG visual artifacts. Mantis before/after
  reports also preserve scenario-provided MP4 artifacts as `baseline.mp4`
  and `candidate.mp4`.
- `discord-thread-reply-filepath-attachment` - opt-in Mantis scenario; see
  [Discord Mantis scenarios](/concepts/qa-e2e-automation/operator-flow#discord-mantis-scenarios).

Run the Discord voice auto-join scenario explicitly:

```bash
pnpm openclaw qa discord \
  --scenario discord-voice-autojoin \
  --provider-mode mock-openai
```

During teardown of a successfully started child gateway, the Discord adapter
keeps its credential lease and heartbeat until that gateway has stopped. If
shutdown fails, the suite withholds lease release.

Run the transcript authorization scenario with a Convex lease whose payload
contains the reserved QA room's `voiceChannelId`:

```bash
pnpm openclaw qa discord \
  --scenario discord-transcripts-voice-authorization \
  --provider-mode live-frontier \
  --credential-source convex \
  --credential-role maintainer
```

Run the Mantis status-reaction scenario explicitly:

```bash
pnpm openclaw qa discord \
  --scenario discord-status-reactions-tool-only \
  --provider-mode live-frontier \
  --model openai/gpt-5.6-luna \
  --alt-model openai/gpt-5.6-luna \
  --fast
```

Output artifacts:

- `qa-suite-report.md`
- `qa-suite-summary.json`
- `qa-evidence.json` - evidence entries for the live transport checks.
- `discord-qa-reaction-timelines.json` and
  `discord-status-reactions-tool-only-timeline.png` when the status-reaction
  scenario runs.
