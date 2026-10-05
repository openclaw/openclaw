---
summary: "X / Twitter mentions, allowlisted public replies, thread context, and event modes"
read_when:
  - Connecting an X bot account to an OpenClaw agent
  - Managing who can trigger public replies on X
  - Troubleshooting X activity streaming or mention polling
title: "X / Twitter"
---

The X plugin turns mentions of your bot account into agent conversations and
posts the agent's answer as a public reply. Only allowlisted authors can trigger
a reply by default. Unknown authors are silently dropped; they receive no
pairing prompt or other response.

Each X conversation is a group thread identified by its `conversation_id`.
The agent receives the triggering mention together with available ancestors,
conversation posts, and quoted posts. The original mention remains the
user-visible message. DMs, original posts, likes, follows, and media uploads are
not supported.

## Setup

The plugin is bundled with builds that include `extensions/x`. To add it to an
OpenClaw 2026.9.8 installation from a local checkout:

```bash
openclaw plugins install --link ./extensions/x
```

Use an X confidential OAuth2 application and authorize the bot account with
`tweet.read tweet.write users.read offline.access`. Keep its client ID, client
secret, and user-context refresh token. The plugin refreshes access tokens with
HTTP Basic client authentication. An optional, separate app-only bearer token
enables the Activity API.

X can rotate the refresh token when issuing an access token. The plugin saves
the latest token in private, worker-backed plugin state (`x.oauth`) so it
survives restarts. Changing the configured refresh-token seed starts a new
token lineage. This storage does not promise encryption at rest; protect the
Gateway's state directory and its backups as credentials.

Set the bot's numeric user ID and username, then add at least one maintainer's
numeric X user ID to `allowFrom`:

```json5
{
  channels: {
    x: {
      enabled: true,
      userId: "123456789",
      username: "example_bot",
      clientId: "example-x-client-id",
      clientSecret: { source: "env", provider: "default", id: "X_CLIENT_SECRET" },
      refreshToken: { source: "env", provider: "default", id: "X_REFRESH_TOKEN" },
      bearerToken: { source: "env", provider: "default", id: "X_BEARER_TOKEN" },
      allowFrom: ["987654321"],
      groupPolicy: "allowlist",
      dmPolicy: "disabled",
      events: { mode: "auto", pollSeconds: 60 },
      threadContext: { maxPosts: 50 },
    },
  },
  bindings: [{ agentId: "main", match: { channel: "x" } }],
}
```

Replace the example IDs and username. Make the referenced environment variables
available to the Gateway. Omit `bearerToken` to use polling without the Activity
API. All three secret fields also accept plaintext or supported
[SecretRef inputs](/gateway/secrets).

Run `openclaw config validate` and `openclaw channels status`. From an
allowlisted account, mention the bot in a post. A successful turn produces a
public reply beneath that post. Normal [channel bindings](/channels/channel-routing)
choose the agent and session; the plugin does not override session scope.

For multiple bots, put account-specific values under
`channels.x.accounts.<accountId>`. Root fields are shared defaults; the default
account ID is `default`.

## Manage the allowlist

Open **X replies** in the Control UI as an administrator. The page shows the
effective union of config `allowFrom` entries and users added through the page.
Add a username to resolve it to a stable numeric X user ID. Stored entries retain
the resolved username, display name, adding operator, and timestamp. Remove a
stored entry from the page; config entries are read-only and must be removed
from config.

A locally linked installation uses the [Custom plugin UI setting](/plugins/feature-plugins#enable-custom-plugin-ui).
Enable **Settings → Labs → Custom plugin UI**, then use the Control UI served by
the Gateway over HTTPS or trusted loopback. Bundled installations do not need
that setting.

The Gateway methods `x.allowlist.list`, `x.allowlist.add`, and
`x.allowlist.remove` require `operator.admin`. Authorize senders by numeric ID,
either `987654321` or `x:987654321`; handles belong in the add-by-handle UI, not
in `allowFrom`.

`groupPolicy: "open"` allows any author whose post reaches the mention feed and
emits a security warning. Keep `allowlist` for a maintainer bot. `disabled`
turns off inbound turns. `dmPolicy` accepts only `disabled`.

## Event modes

| Mode     | Behavior                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `auto`   | Uses the Activity API when a bearer token is configured and subscriptions succeed; otherwise polls mentions.              |
| `stream` | Requests Activity API streaming with the app-only bearer token; falls back to polling when no bearer token is configured. |
| `poll`   | Polls the mentions endpoint using the user-context token.                                                                 |

The default is `auto`. Streaming lists existing subscriptions with the app-only
`bearerToken`, then creates a missing `post.mention.create` subscription for the
bot with its OAuth2 user access token (refreshed from `refreshToken`). Mention
subscriptions require the user to grant `tweet.read`. The persistent
`GET /2/activity/stream` connection uses the app-only bearer token, as specified
by [X's Activity Stream API](https://docs.x.com/x-api/activity/activity-stream).

Streaming reads `post.mention.create` events from X's `data.payload` envelope,
checks that the post addresses the bot, and ignores other event types and blank
keep-alives. It reconnects with backoff after a stalled or disconnected stream.
Each connection runs a mentions backfill with the user token from the saved
cursor; post IDs deduplicate stream and polling events.

In `auto` mode, any subscription setup failure switches to polling. In `stream`
mode, subscription HTTP `403` switches to polling; other setup errors stop the
event source. A stream HTTP `401` or `403` switches either mode to polling. The
channel status `message` includes the failed endpoint, HTTP status, and first X
error message when available, with credentials redacted. For example:

```text
X API /2/activity/subscriptions failed (HTTP 400): OauthAccessTokenRequired: OAuth user access token is required for this event type; polling
```

This message explains why Activity could not start; polling remains active.
Unreadable error bodies still report the HTTP status. Network and token-refresh
failures report their client error without provider response details.

Polling defaults to 60 seconds; `events.pollSeconds` cannot be less than 15.
Inbound posts are durably queued before the cursor advances. Completed event
IDs are retained for up to 30 days with a limit of 2,000 completed entries per
account, preventing duplicate turns after reconnects and restarts while those
entries remain retained.

## Thread context and replies

The plugin renders available thread posts oldest first as `@handle (time): text`
and marks the triggering mention. It follows reply ancestors, reads the recent
conversation, and includes quoted posts. `threadContext.maxPosts` defaults to
50; the root and newest posts are kept when the limit is reached. Recent-search
coverage is limited to seven days, and unavailable or deleted posts cannot be
included.

Replies are split into a self-reply chain with at most 280 weighted characters
per post; each URL counts as 23 characters. The last chunk receives
`replySignature`, whose default is `🤖 automated reply`. Set it to an
empty string to disable the signature.

When the agent starts a visible work session, its first session URL is appended
to the reply unless the text already contains that URL. This is a public link
in a public reply and uses X's URL-containing reply price.

For direct replies through the message tool or CLI, target the post ID with an
`x:` prefix or its full X status URL:

```bash
openclaw message send --channel x --target x:1234567890123456789 --message "Reply text"
```

The target must satisfy X's reply eligibility: its author mentioned or quoted
the app account. Sending media or creating an original post is unsupported.

## Costs

| Operation              | X API price                                        |
| ---------------------- | -------------------------------------------------- |
| Post read              | $0.005 per returned post, deduplicated per UTC day |
| Reply without a URL    | $0.015 per reply post                              |
| Reply containing a URL | $0.20 per reply post                               |
| Username lookup        | $0.01 per lookup                                   |
| Empty mentions poll    | No post-read charge                                |

Thread expansion reads additional posts. A long answer creates multiple billed
reply posts. Adding a handle in the allowlist UI performs a paid username
lookup. These are X API costs, separate from the agent's model usage.

When an Activity event omits mention entities, the plugin looks up the post to
verify that it targets this bot before queueing it. Events for another bot do
not advance this account's cursor. If a mention entity provides only a username,
the plugin performs a $0.01 user lookup to verify the numeric recipient ID;
configured usernames alone cannot authorize a reply.

## Configuration reference

These fields work at `channels.x` and on individual account entries unless noted.

| Field                    | Default              | Purpose                                                                 |
| ------------------------ | -------------------- | ----------------------------------------------------------------------- |
| `enabled`                | `true`               | Enables the channel or account.                                         |
| `name`                   | Unset                | Optional account display name.                                          |
| `userId`                 | Required             | Numeric user ID of the bot account.                                     |
| `username`               | Required             | Bot username without `@`.                                               |
| `clientId`               | Required             | OAuth2 confidential application client ID.                              |
| `clientSecret`           | Required             | Application secret; supports SecretRef.                                 |
| `refreshToken`           | Required             | Bot's user-context OAuth2 refresh token; supports SecretRef.            |
| `bearerToken`            | Unset                | App-only Activity API bearer token; supports SecretRef.                 |
| `events.mode`            | `auto`               | `auto`, `stream`, or `poll`.                                            |
| `events.pollSeconds`     | `60`                 | Mentions polling interval, minimum 15 seconds.                          |
| `allowFrom`              | `[]`                 | Numeric author IDs, optionally prefixed with `x:`.                      |
| `groupPolicy`            | `allowlist`          | `allowlist`, `open`, or `disabled`.                                     |
| `dmPolicy`               | `disabled`           | Only `disabled` is accepted.                                            |
| `threadContext.maxPosts` | `50`                 | Maximum posts included in agent thread context, from 2 to 100.          |
| `replySignature`         | `🤖 automated reply` | Added to the last reply chunk; up to 140 characters, empty disables it. |
| `accounts`               | Unset                | Named account overrides; channel root only.                             |
| `defaultAccount`         | `default`            | Account selected when none is specified; channel root only.             |

## Troubleshooting

**No reply:** check the account's status, numeric bot ID, and effective allowlist.
The dropped-mention counter and last dropped author explain intentional silence.
There is no pairing flow. An empty allowlist blocks all authors under the
default policy.

**Streaming falls back:** check the status message for the Activity endpoint,
HTTP status, and X error detail. Verify the app bearer and the bot's OAuth2
grant, including `tweet.read`. Without an app bearer, `auto` and `stream` use
polling. Check the reported event mode, stream connection/backoff, last event,
and cursor.

**Token refresh fails:** check the client ID, client secret, refresh token, and
granted OAuth2 scopes. Status reports refresh state without exposing secrets.

**Reply rejected:** confirm the source author mentioned or quoted the app
account and the app has `tweet.write`. Inspect the error before retrying a
partially sent reply chain.

Failures before a reply POST can retry safely. If a POST's outcome is uncertain,
OpenClaw keeps that uncertainty instead of automatically sending the reply again.
Check X before manually retrying an uncertain or partially sent reply.

## Related

- [Channel routing](/channels/channel-routing)
- [Configuration](/gateway/configuration)
- [Secrets](/gateway/secrets)
- [Manage plugins](/plugins/manage-plugins)
