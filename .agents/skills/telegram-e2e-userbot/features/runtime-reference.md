# Telegram E2E runtime reference

Read this file only for a non-default backend, manual driver operation, event
interpretation, persistent fixtures, forum topics, or a failed run. The primary proof sequence stays in
[`SKILL.md`](../SKILL.md).

## Published-driver topic-binding upgrade

The npm Telegram lane's standalone `telegram-published-upgrade-bindings` selector
proves that a topic an installed published Gateway handed to a spawned worker
returns to its parent session after that Gateway's own updater and the
candidate's next restart. Run it only in the lane's isolated
container: the secretless install phase owns the published prefix, and the
validated candidate tarball is mounted read-only for the live phase.

The lane invokes:

```sh
node .agents/skills/telegram-e2e-userbot/scripts/run-published-upgrade-user-e2e.mjs \
  --baseline /npm-global/bin/openclaw \
  --baseline-spec openclaw@2026.9.6 \
  --candidate /package-under-test/openclaw-2026.9.6.tgz \
  --output /out/telegram-upgrade
```

Use the exact published version selected by the workflow. Before leasing, the
command verifies the installed baseline, reads the candidate's build identity
and nine reached runtime artifacts without executing package code, and prepares
the pinned TDLib through the maintained loader. It uses existing Python 3 and
the driver's standard-library implementation, without `uv` or a source build.

One maintained credential/run scope owns fixture setup, the proxy, recorder,
mock provider, installed Gateway children, and updater. The published baseline
must accept a real `sessions_spawn` with `thread:true` and `mode:session`, and
both parent and child must reply in the actual topic before shutdown; this
legacy spawn binding hands the current topic to the child. The genuine published
CLI then runs `update --tag file:<candidate> --yes --no-restart --json` with the
same runner-created config, token file, workspace, and databases. The candidate
no longer honors spawn-created bindings on the current Telegram conversation, so
the next topic turn and its reply must land in the parent topic session
transcript, not the child's, both after activation and after another restart.
The child keeps its canonical identity and spawn-phase history, and no later
turn reaches it. Each of the three Gateway stops requires a joined exit
code 0 with no signal; forced process cleanup cannot qualify orderly shutdown.
Artifact hashes, native observations, accepted tool-result correlation, canonical
session identity, and receipt-scoped cleanup all participate in the verdict.

Initial windows are 900 seconds for the updater and 1,800 seconds for recording;
the native readiness and authoritative RPC checkpoints retain their own bounded
deadlines. A timeout fails the run and is not retried. Existing package-registry
settings belong to the npm lane and are preserved for the updater; broker
credentials are not inherited by it.

Only `published-upgrade.json` goes to the public output directory. It reports
package identities, proved relationships, and typed failure facts for updater,
shutdown, checkpoints, and cleanup. Missing lease-release confirmation stays
unknown even after fixture deletion succeeds. Raw logs, transcripts, native
identities, credentials, and runtime state remain in separate private temporary
storage. Successful runs remove that storage; failed runs retain it for their
container's existing cleanup policy. Do not upload the raw temporary tree or
replay uncertain fixture/update mutations without reconciling the owned state.

## Chat selection

`--chat` accepts a TDLib chat id, `@username`, invite link, or `t.me` link.
`--dm` targets the selected SUT directly.
Select a forum explicitly with `--chat`; scenario sends use `forumTopicId` to
choose a topic within it. The default group comes from the credential's `groupId`.

Prefer DMs for isolated turns. A shared group records unrelated traffic and all
privacy-disabled pool bots can see its messages. Use a group only when its
behavior is part of the claim.

In probe mode, pair `--dm` with `--any-sut-reply`. A bot normally answers a DM
without a native quote, while the default probe filter requires one. Recording
mode captures facts and rejects that flag.

## Persistent fixtures and topics

Reuse established groups when available. The fixture owner verifies the QA user,
bot membership, actual group type and topic permissions. Select a forum through
`--chat`; the broker supplies only the normal group reference. The runner checks
the selected target on its own lease; a stored reference alone is not readiness.

Keep persistent groups and established bot membership after proof. Remove only
the messages and topics created by the run, using the
[account-scoped receipts](#message-identity) while its credential lease is still
valid. Preserve full events before cleanup and verify the deletion result.

For the pinned Test Server runtime, create a non-channel supergroup first, then
enable its forum through `toggleSupergroupIsForum`. Verify `is_channel: false`
and `is_forum: true` from the real response. A successful creation response does
not by itself prove the requested type. Save each created identity before later
setup steps; honor explicit server retry-after responses and reconcile uncertain
creation before retrying.

A scenario send can select an existing forum topic:

```json
{
  "actions": [
    { "type": "send", "atMs": 0, "text": "@{sut} Reply in this topic.", "forumTopicId": 42 }
  ]
}
```

A scenario send can also carry a photo (`photo`, absolute path; `text` becomes
the optional caption) or reply to the newest message this scenario sent
(`replyToPrevious: true`), for reply-context and caption-command proof:

```json
{
  "actions": [
    { "type": "send", "atMs": 0, "photo": "/abs/path/fixture.png" },
    { "type": "send", "atMs": 8000, "text": "/btw what is in this image?", "replyToPrevious": true }
  ]
}
```

Create the run-owned topic under the held lease and use its actual returned id.
The direct driver also accepts `send --forum-topic-id <id>`. TDLib 1.8.67 uses
`topic_id: messageTopicForum` for forum topics; ordinary message threads use
`messageTopicThread`. Inspect `topicType` and `topicId` on both the sent message
and the SUT reply. A reply in the general topic does not prove topic routing.

A send confirmation failure stops later scenario actions in both the recorder
and Node runner. The uncertain send is never retried. Passive Telegram recording
continues to the original deadline, preserving late updates and the failed
action in the evidence; the run exits unsuccessfully even if a reply arrives.

Keep one TDLib client per restored state directory. Run custom TDLib inspection
before the recorder starts or after it exits, under the same live lease. Bot API
inspection can use the scenario `command` action while recording.

## QA Lab participant identity fixtures

The QA Lab Telegram adapter accepts optional fields on one Convex-leased Test
Server credential: `forumGroupId`, positive numeric `forumTopicId`, and
`participants`. Each additional participant supplies a unique lowercase `alias`,
`testerUserId`, `tdlibArchiveBase64`, `tdlibArchiveSha256`, and `tdlibVersion`.
The pool owner provisions these independently authorized users under the same
lease. The SUT bot and every participant must already belong to the selected
group and forum, and the topic must exist. No credential is acquired by merely
listing scenarios or running deterministic support tests.

For mixed-user flows, use `senderId: primary` and the additional aliases. A
single-user fixture binds its first scenario sender label to its leased user;
changing that label cannot impersonate a second person. `conversation.kind:
direct` sends to the SUT DM. A group/channel conversation uses `groupId`; adding
a positive numeric `threadId` selects that forum topic in `forumGroupId` (or the
existing group when it is itself a forum). Each native chat/topic belongs to one
logical conversation until transport reset. Replies require a receipt observed
by the sending participant in that chat; TDLib message IDs cannot cross accounts.

Flow preparation exposes in-memory `telegramIdentityFixture.participantAliases`
and `forumTopicId`. Set `execution.config.requireParticipantIdentityFixture:
true` to require the complete mixed-user/forum fixture before sending. It also
retains the existing `readTelegramMessages()` observer for native topic evidence.
These inputs enable real Telegram identity proof; deterministic adapter tests do
not claim that live transport or audit inspection has run.

## Backends

| Backend      | Use                                                                     |
| ------------ | ----------------------------------------------------------------------- |
| `mock`       | Default deterministic OpenClaw `mock-openai` turn.                      |
| `qa-mock`    | QA fixtures for tools, delays, and scenario actions.                    |
| `claude-cli` | Real Claude CLI path for progress behavior the mock lane cannot render. |

Prepare `qa-mock` with `OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build` before leasing.
The built lane starts both the provider and Gateway from that checkout's
`dist/entry.js`; `--source-gateway` selects the development launcher for both.
A leased run must not rebuild a dirty source checkout while waiting for provider
readiness.

The named tool-progress shell fixture emits command-style `exec` arguments.
Use `E2E_ROOT_CONFIG_PATCH='{"tools":{"codeMode":false}}'` for that fixture, or
choose a code-mode-aware fixture. Keep exec permissions unchanged and verify
the actual tool result: a planned call alone does not prove the command ran.

`claude-cli` uses the operator's Claude credentials and costs real usage. Its
default model is `claude-haiku-4-5`; set `E2E_TELEGRAM_CLI_MODEL` to override it.

```bash
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --backend claude-cli --dm \
  --text 'Use Bash to run: echo alpha. Then reply with only the output.' \
  --record /tmp/events.ndjson --output /tmp/summary.json
```

## Evidence model

Each recognized event keeps its raw TDLib update in NDJSON. The summary adds a
normalized timeline:

```json
{
  "recordingComplete": true,
  "totals": { "message": 1, "edit": 2, "delete": 1 },
  "sutTotals": { "message": 1, "edit": 2, "delete": 1 },
  "timeline": [{ "elapsedMs": 8159, "kind": "message", "botApiMessageId": 46145, "isSut": true }]
}
```

`kind` is `message`, `edit`, `edit-meta`, `delete`, `typing`, or `reaction`.
Message and edit rows include SUT identity, reply target, quote text, topic,
content type, and extracted rich-message text. Reaction rows include emoji and
count.

| Claim                    | Required fact                                                      |
| ------------------------ | ------------------------------------------------------------------ |
| Draft changed over time  | Successive `edit` rows on one raw `messageId` in this user's chat. |
| Final replaced the draft | Final `edit` on that same id.                                      |
| Draft was removed        | A later `delete` for that id.                                      |
| Bot typed before reply   | A `typing` row before the message.                                 |
| Ack reaction changed     | Reaction rows on the QA user's sent message id.                    |

Telegram sends reaction updates for messages authored by the QA user. A bot
reacting to its own message produces no user-visible reaction update.

### Message identity

Bind IDs to the authorized account, selected chat, and API that returned them.
The recorder retains the historical field `botApiMessageId` for existing artifact
consumers, but its value is the observing account's compact TDLib ID, not a
cross-account Bot API receipt. Use raw `messageId` for this user's operations.

For Bot API cleanup, use the original bot send receipt's chat and message IDs
with that leased bot. For TDLib cleanup, use the user's actual send receipt or
an observed run-owned message's raw ID in the selected chat. Check the run's
time, sender, and identifying content against the retained action. The shared
QA sender alone is not run ownership. An older message or content mismatch
stops cleanup; a matching numeric projection cannot override that failure.

## Manual driver operation

The routine runner supplies all state through one Convex lease. Use low-level
commands only inside runner-owned credential state:

```bash
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" doctor --json
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" status --json
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" chats --json
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" send --text '/status@{sut}'
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" transcript --limit 20
uv run "$TELEGRAM_E2E_SKILL_DIR/scripts/user-driver.py" probe \
  --text '@{sut} Reply exactly: USER-E2E-{run}' --expect USER-E2E-
```

The leased credential supplies the group id, SUT token and identity, tester id,
TDLib configuration, and authorized session. Credential state lives in a
private runner directory. The shared cache at
`~/.cache/openclaw/telegram-e2e-userbot/tdlib` contains only the TDLib binary.

`TELEGRAM_USER_DRIVER_TDLIB_PATH` selects a deliberate custom TDLib build.
`login --qr` is an owner-repair action for a session that cannot be restored; it
is not a routine maintainer step.

## Retained-run recovery

Failed fixture cleanup can leave a private lease directory with `lease.json`
and credential state. Preserve that directory and the failure evidence. The
receipt contains a secret broker handle: exclude it from proof exports and
public output. Its presence alone does not establish live authority.

Use the same configured temporary root as the original run. The recovery helper
revalidates the exact broker owner before each operation; it does not acquire
another credential:

```bash
node "$TELEGRAM_E2E_SKILL_DIR/scripts/telegram-test-recover.mjs" \
  "$TELEGRAM_RETAINED_LEASE_DIR" status
```

`status` leaves the lease held. `cleanup-group` removes a confirmed run-owned
group and credential state before releasing it. `release` handles a retained
broker receipt only after credential state is gone. A rejected revalidation is
a real authority stop; never use the saved session directly after it.

These commands are conveniences, not the limit of agent recovery. Adapt the
harness under the revalidated lease when more inspection is needed. For an
uncertain creation, compare the preserved intent with actual Telegram state
before choosing cleanup; never retry creation blindly or mark a group deleted
without proof. Preserve unknown files and shared fixtures.

## Config controls

[The verification map](README.md#reaching-non-default-config) is the source of
truth for environment knobs and scenario actions. Read that section when the
proof needs non-default channel or root config, prior history, timed actions,
gateway restarts, cron delivery, or health sampling.

## Convex launcher diagnostics

The helper uses the explicit broker pair when both values are present; it never
mixes one explicit value with another source. Without the pair it tries the
existing `convex`, `bunx --no-install convex`, and
`npx --offline --no --ignore-scripts convex` launchers in that order, from
`qa/convex-credential-broker`. The npm flags disable registry access, installation
approval, and lifecycle scripts; `--offline` alone would still allow installation
from npm's package cache. Bun's `--no-install` requires an already available CLI.

Each attempt reads `OPENCLAW_QA_CONVEX_SECRET_CI` with
`env --deployment <broker> get` against the repository's existing published
broker deployment. Its matching site is the default; an explicit broker pair
still overrides it. No local `CONVEX_DEPLOYMENT` or project-selection file is
required. There is no dashboard lookup, login, browser opening, deployment,
or local config mutation. Each launcher gets one 15-second lookup and joins
its owned processes on cancellation.

Read the sanitized launcher status in the error. `UNAVAILABLE` means an existing
executable/package was not found; `AUTH_REQUIRED` means existing authentication
failed; `PROJECT_ACCESS` means broker-project access needs checking. Successful
`env get` with empty output is `BROKER_CONFIG`: Convex can
exit zero for a missing variable. Check the broker owner, not login. Resolve
connectivity or runtime failures before concluding credentials are missing, and
ask the user for authentication only after all existing routes fail to authenticate.
Raw CLI output may contain secrets; retain only the sanitized status publicly.

## Failure triage

The runner must own the gateway under test. A gateway from another checkout can
use the wrong token, config, or code.

A scenario send whose confirmation fails records a failed action without a sent
receipt, then observes the remainder of the recording window. Keep that NDJSON;
the server may have accepted the send. Do not retry the send or later actions
until the observed state is reconciled.

If no SUT reply appears, inspect these boundaries in order:

1. The credential restored and `status --json` reports `testDc: true` and TDLib `1.8.67`.
2. The SUT Test Bot API reports no webhook and no stale pending updates.
3. The gateway log shows the selected Telegram provider and an inbound update.
4. `mock-openai-requests.ndjson` contains the expected provider request.
5. The gateway log contains an outbound send for the same chat.

Zero provider requests means the turn never reached the model. A `401` from
`api.openai.com` means the gateway did not use the mock base URL. An outbound
send plus no observed reply points to TDLib authorization or chat selection,
not the model.

## Runtime facts

- `botApiMessageId` is the recorder's historical name for the observing account's server message ID (`messageId >> 20`). Keep that artifact field, but do not equate it with another account's Bot API receipt in a DM or basic group: those message ID sequences are account-specific. Channels/supergroups share their sequence. See [Telegram's message-ID contract](https://core.telegram.org/api/updates#message-id-sequences).
- Correlate a DM send with a unique run marker in the observed content. Keep the bot receipt for bot-side edits; use the original raw observer `messageId`, edit kind, and a fresh marker to prove the observer saw that same message change. Formatting assertions must still inspect the full native tree; a marker alone is not formatting proof.
- Uploaded QA artifacts are not private. Retain raw identities only in memory; export run-local labels and measured relationships. Export bounded, metadata-free trees only for marker-correlated synthetic fixtures, and counts/types only for unmatched observations.
- Serve-mode observations stay within the selected chat and fetch incomplete content with `getFullRichMessage` using the observing account's chat/message pair before emitting a complete snapshot. Intervening updates remain queued; the response has no revision token, so this is not a revision-perfect historical snapshot. Raw recording and transcript normalization preserve the original partial content instead of fetching or relabeling it.
- TDLib replays cached updates after connect; judge only events after the run's sent action.
- The driver pins `@prebuilt-tdlib` `0.1008067.0`, which reports TDLib `1.8.67`.
- TDLib 1.8.6 and later take the existing base64 database key in `setTdlibParameters`; re-encoding changes the key.
- OpenClaw does not expose grammY's Test Server option, so the loopback proxy inserts `/test` after the bot token.
- Broker calls time out after 15 seconds. A failed heartbeat fences the runner before later actions and stops an active probe.
- Chunked broker payloads are authenticated per chunk and bounded to 64 MiB and 4096 chunks before JSON parsing.
- Scope gateway logs with `logging.file`; the default `/tmp/openclaw/<date>.log` mixes concurrent runs.
- Gateway logs do not prove edit versus send; TDLib events do.
- Progress drafts are provider-shaped; a single final-answer fixture correctly records no progress revisions.
