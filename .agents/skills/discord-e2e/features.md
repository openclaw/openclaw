# Discord feature recipes

## Select the boundary

| Claim                          | Drive                                                                                 | Required evidence                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Guild ingress and public reply | `send({mention: true})`, then `waitForReply`                                          | SUT identity, originating channel, newer message ID, native reply reference or unique marker; provider request for a model turn |
| Quiet/mention gating           | `send({mention: false})` with genuinely unmentioned text                              | Recorder window and Gateway/provider evidence; quiet means no mention metadata, not a promise of silence under arbitrary config |
| Reply context                  | `send({replyToMessageId, text, mention})`                                             | Native message reference and SUT reply content showing the relevant context                                                     |
| Read/history pagination        | `read({messageId})` or `read({before/after, limit})`                                  | Native message IDs/content; cursors are Discord snowflakes, pages are not a channel sweep                                       |
| Edit/delete                    | Native fixture `edit`/`delete` on a driver receipt, or drive the changed SUT behavior | API readback for fixture changes; SUT `MESSAGE_UPDATE`/`MESSAGE_DELETE` rows for product claims                                 |
| Reactions                      | Fixture `react` add/remove on an owned message, or drive SUT status reactions         | `MESSAGE_REACTION_*` with reactor identity and driven message ID; aggregate reaction counts do not identify the SUT             |
| File upload                    | `upload({path, fileName, text})`                                                      | Receipt/readback attachment metadata; actual model tool trace if claiming agent upload behavior                                 |
| Thread routing                 | `thread`, then `send/read/waitForReply` with returned `threadId`                      | Owned thread ID, parent lease channel, reply identity/cursor in that thread                                                     |
| Streaming/typing               | Configure the real SUT, then send a fresh trigger                                     | SUT revisions/deletes/typing from the event recorder; typing establishes actor/channel timing, not a causal reply reference     |
| Embeds/components              | Observe a real public SUT message                                                     | Public metadata and actual client rendering when visual shape matters; clicking components remains manual                       |

Native mutations reject unknown message IDs and threads. Reading a message does
not grant ownership. Edits/deletes target driver-created receipts; reactions can
also target a correlated SUT receipt. Reply targets must belong to the current
scenario. Thread creation is confined to a driver-owned parent message in the
leased guild text channel. Uploaded files are removed from Discord with their
owned message; the local source file remains the scenario's responsibility.

`read` takes a limit from 1 to 100 and either `before` or `after`, not both.
`send`/`upload` default to quiet fixture ingress. `mention: true` targets only the
leased SUT, suppressing broad mentions and reply-user pings. Use the exact shared
contract at `extensions/qa-lab/src/live-transports/shared/channel-e2e.types.ts`.

## Minimal custom flow

Start from `qa/scenarios/channels/discord-e2e-lifecycle.yaml`; retain its live-driver
constraint, isolated suite, timeout, and disabled retries. The prepared
`channelE2e` object is a flow variable, alongside `discordScenarioContext`, `env`,
`fs`, `path`, and the existing QA helpers. A correlation-safe turn looks like:

```yaml
- set: marker
  value:
    expr: "'OPENCLAW_E2E_DISCORD_' + randomUUID().replaceAll('-', '').toUpperCase()"
- call: channelE2e.send
  args:
    - text: { expr: "'reply exactly: ' + marker" }
      mention: true
  saveAs: trigger
- call: channelE2e.waitForReply
  args:
    - afterMessageId: { ref: trigger.id }
      textIncludes: { ref: marker }
      timeoutMs: 60000
  saveAs: reply
- assert:
    expr: reply.actor === 'sut' && reply.text.includes(marker)
    message: No correlated SUT reply
```

`waitForReply` requires an owned driver trigger (explicit `afterMessageId` or the
last send/upload). It rejects older messages, other authors/channels, and native
references to a different trigger. Without a native reference, supply a unique
`textIncludes` marker. A generic substring such as `OK` is weak correlation.

## Model tools versus fixture operations

To prove the agent uses the message tool, ask the SUT to perform the specific
operation through a real mention and inspect its session/tool trace. A native
`channelE2e.upload`, `react`, or `edit` call is merely fixture setup even though
Discord accepts it. Mock OpenAI is deterministic Gateway/provider plumbing proof;
use the existing provider flags with a permitted live model when model decisions
are the subject. Do not substitute direct REST calls for a failing model path.

For advanced scenarios, use the existing `flow.module`/`flow.call` API and the
prepared `channelE2e` object; do not invent a separate action-file language.
Curated `discord-progress-draft-lifecycle`, `discord-status-reactions-tool-only`,
and `discord-thread-reply-filepath-attachment` scenarios remain useful stronger
product-boundary examples. Their legacy retention is unchanged unless the new
agent-E2E path is explicitly selected.

## Permission and observation limits

Doctor checks both bots' guild membership, View Channel, Read Message History,
Send Messages, and Send Messages in Threads. The driver also needs Add Reactions,
Attach Files, and Create Public Threads. The driver Gateway requires the
MESSAGE_CONTENT privileged intent. Missing access fails; the runner neither
grants permissions nor rotates credentials to hunt for a pass. Runtime API
rejections (including dynamic permission changes, archived/locked threads, file
limits, and rate limits) remain real failures.

Manage Threads is optional: an existing grant permits deletion of owned threads;
otherwise cleanup archives them and records that retained disposition. No
Manage Messages grant is needed to delete a bot's own messages. SUT attachments
and public component/embed metadata can be observed, but ephemeral content,
slash-command invocation, user component/modal interactions, and bot DMs require
an authorized manual Discord client. Synthetic interaction payloads are isolated
boundary tests, never live Discord interaction evidence.
