# Slack user OAuth proof

Use this lane to verify the shared human account and exercise text through
Slack's official Web API. It is not a Slack client automation session or an
OpenClaw Gateway test. The existing `qa slack` lane still uses its bot driver.

## Bootstrap

From the source checkout, with its normal dependencies and Convex login:

```bash
node .agents/skills/slack-e2e/scripts/user-oauth-smoke.mjs
node .agents/skills/slack-e2e/scripts/user-oauth-smoke.mjs --smoke
```

No token flags or secret environment variables are needed. `--output-dir` accepts
a **new** private directory; existing directories are rejected to preserve prior
receipts. The default is a unique directory under `.artifacts/skill-e2e/`.

The command leases `kind=slack` through the existing shared lease helper. The
operator-provisioned payload must include:

| Field                                     | Purpose                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `driverUser.token`                        | Official user OAuth token, not a bot token or Slack browser session |
| `driverUser.userId` / `driverUser.teamId` | Pinned QA human and workspace identities                            |
| `driverBotToken`                          | Driver app identity in the same workspace                           |
| `channelId`                               | Dedicated QA channel available to the user                          |

These are fields in the existing pool payload, not new QA Lab configuration.
Retain the pool's SUT credentials for the unchanged Gateway lane. Do not paste
payloads into chat, shell arguments, logs, or commits. A missing user credential
is an operator prerequisite, not permission to use a personal account, extract
browser cookies, rotate through leases, or replace the bot driver silently.

## Permissions and identity

Readiness calls `auth.test`, `users.info`, `bots.info`, and channel history. It
checks the pinned active human, workspace, paired driver bot/app identity, and
history access. User profile lookup needs `users:read`; history needs
`channels:history` for public or `groups:history` for private channels. The driver
bot needs access to `bots.info` (`users:read`). Smoke additionally needs user
`chat:write` and permission to edit/delete its own messages. Workspace policy can
still block an operation. Readiness alone does not prove write permission.

Admin status does not replace OAuth scopes, channel access, or API support.
Have the pool owner grant only the permissions required by the intended flow
and complete Slack's install/consent process when scopes change. This command
does not change permissions, provision credentials, refresh tokens, or join
channels. Report the failing method and Slack error rather than altering the
app to manufacture a pass.

## What a pass means

- Default: Slack reads succeeded and the broker confirmed lease release. It
  writes no Slack messages, but it does change lease state in Convex.
- `--smoke`: one unique, unmentioned top-level message was created, read back
  under the pinned human identity, edited, read back again, deleted, and observed
  absent. The command never changes another message. Other workspace listeners
  may observe the synthetic message; absence of a mention is not a silence test.
- `appAttributed: true`: Slack included app/bot attribution on the stored user
  message and its app ID matched the paired driver app. This is valid API-user
  evidence, **not** proof that OpenClaw treats it like text from the Slack client.
  Readiness alone cannot bind the user token to that app; the stored smoke
  message provides the attribution check when Slack includes it.

`result.json` contains private native IDs, the synthetic marker, check results,
operation states, and cleanup state. It contains no tokens or channel history.
The directory is mode `0700`; the result is mode `0600`. Stdout prints checks,
cleanup, and the artifact path, not native IDs. Sanitize paths and identities
before public sharing.

API-user text does not prove Socket Mode ingress, a Gateway reply, model tool
selection, buttons, slash commands, Agent View, or client rendering. Use the
[Gateway recipes](features.md) or an authorized Slack client for those claims.
Do not add the withdrawn user-driver flags to `qa slack`.

## Failure and recovery

| Result                                                      | Action                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Convex login/pool failure                                   | Restore access through the pool owner; no Slack side effects are claimed     |
| Missing `driverUser`, wrong identity, inactive user         | Stop before writing; ask the pool owner to repair that credential            |
| `missing_scope`, `not_in_channel`, `not_allowed_token_type` | Report the method, actor, and requested operation; do not switch tokens      |
| `token_expired`, `token_revoked`, `invalid_auth`            | Owner repairs the shared OAuth grant; keep secret values out of reports      |
| `ratelimited`                                               | Stop this run; do not loop writes or expand permissions                      |
| `pending` or `uncertain` create                             | Preserve the receipt artifact; do not replay or infer ownership from history |
| Cleanup incomplete or lease release unconfirmed             | Report failure and hand private receipts to the pool owner                   |

SIGINT/SIGTERM stop new test actions. An in-flight request may still have committed;
the command lets it settle within its request timeout. An exact create receipt
allows cleanup under the still-live lease, even after cancellation. Lease loss
blocks all further Slack requests, including cleanup. The command releases the
lease in `finally`; a hard kill cannot guarantee cleanup or release.

Cleanup deletes only the returned message ID in the leased channel and checks
that exact timestamp for absence. A rejected delete, failed readback, lost lease,
or ambiguous create is not a pass. Do not bulk-delete history, blindly replay a
write, or acquire a different credential to clean this run. Resolve current
lease authority and exact ownership with the pool owner first.

Slack API references: [posting](https://docs.slack.dev/reference/methods/chat.postMessage/),
[user identity](https://docs.slack.dev/reference/methods/users.info/),
[deletion](https://docs.slack.dev/reference/methods/chat.delete/).
