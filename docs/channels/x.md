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
      costLimits: { dailyUsd: 100, monthlyUsd: 1000, cycleStartDay: 1 },
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

The page also shows this account's estimated X API spend for today and the
current billing cycle against its limits. Select **Refresh** to update the
read-only totals. The same spend snapshot is included in `x.allowlist.list`.

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

The default is `auto`. Streaming ensures a `post.mention.create` subscription
for the bot, ignores blank keep-alives, and reconnects with
backoff after a stalled or disconnected stream. Each connection runs a mentions
backfill from the saved cursor; post IDs deduplicate stream and polling events.
An Activity API `403` switches to polling and reports:

```text
activity API unavailable for this app; polling
```

Polling defaults to 60 seconds; `events.pollSeconds` cannot be less than 15.
Each request asks for 10 mentions, X's minimum page size, and follows pagination
when a backlog remains. This keeps each request's reservation small while still
catching up on all available mentions.
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

Conversation searches request between 10 and 100 posts, bounded by the remaining
context allowance; X requires a minimum of 10. Pagination stops when the context
limit is reached. If the budget cannot cover more context, the agent receives
the mention and any context already fetched, marked "thread context truncated
by budget."

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

<a id="costs" />

## Costs and limits

The plugin defaults to **$100 per UTC day** and **$1,000 per billing cycle** for
each account. These limits cover X API calls only; model tokens are separate.
Set `costLimits.cycleStartDay` to the UTC day of the month on which your X
billing cycle starts, from 1 to 28. For example, `20` makes a cycle run from the
20th at 00:00 UTC until the next month's 20th. Account entries inherit these
fields from `channels.x` and can override them individually.

Both limits accept nonnegative dollar amounts. `0` blocks paid requests. There
is no unlimited setting; use large limits if you want a higher ceiling. X's own
per-cycle cap still applies and can reject requests independently.

The estimates use X's [published pay-per-use rates](https://docs.x.com/x-api/getting-started/pricing),
verified October 4, 2026:

| Operation                                                   | Estimated X API price                              |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Post read                                                   | $0.005 per returned post, including expanded posts |
| User read                                                   | $0.01 per returned user, including expanded users  |
| Activity `post.*` event                                     | $0.005 per delivered event                         |
| Reply without a URL                                         | $0.015 per reply post                              |
| Reply containing a URL                                      | $0.20 per reply post                               |
| Empty resource response                                     | $0                                                 |
| Subscription management, token refresh, resource-free lists | $0                                                 |

Thread expansion reads additional posts. A long answer creates multiple billed
reply posts. Adding a handle in the allowlist UI performs a paid username
lookup. These are X API costs, separate from the agent's model usage.

Spend is stored in the plugin's worker-backed state as integer micro-dollars,
with separate daily and billing-cycle buckets per account. The plugin reserves
the worst-case cost before each paid request and settles against returned
resources, releasing any unused reservation. Concurrent requests share the
same account budget. A lost response, HTTP 5xx, or unparseable success retains
the full reservation because dispatch may have succeeded; only proven
non-dispatch or an explicit HTTP 4xx rejection releases it without resources.
Displayed spend includes pending reservations. A request spanning UTC midnight
counts conservatively toward both days, but only once toward a shared billing
cycle. Crossing the billing-cycle boundary counts toward both cycles.
Interrupted requests retain their full reservation after a restart.

Accounting deliberately ignores X's resource deduplication within a UTC day,
so repeated reads count again. Whether X bills expanded users is not confirmed;
the plugin includes them to avoid underestimating spend. All delivered
`post.*` Activity events count, even if they do not produce an agent turn. The
estimate can therefore exceed X's invoice.
X's Activity and pricing pages disagree about whether `post.delete` is billed;
the plugin conservatively counts it at the same rate as other post events.

Activity streaming uses a fixed **$0.50 headroom**. If either remaining budget
falls below it, the plugin closes the stream and uses gated mention polling
until the affected budget resets. Events X already delivers before the stream
closes are still charged and admitted; they can push recorded spend over a
limit. The headroom reduces that risk, but it is not a strict bound on a burst
already delivered by X. Polling requests continue only when their full
reservation fits.

When no paid poll fits, ingress pauses until reset without advancing its
`since_id` cursor. Already fetched mentions are durably admitted, and their
next-page token is saved beside the cursor so backfill can continue through
older pages after reset or restart. If X rejects a saved token, the plugin
restarts that backfill from `since_id`; the ingress queue deduplicates mentions
already admitted. Channel status reports the current
spend, limits, cycle start, and resume time, with a reason such as
`X API daily budget of $100 reached; resumes at 2026-10-06T00:00Z`.
The plugin logs once when a limit is reached and once when it resets. A reply
that cannot be afforded is refused with a non-retryable error; a reply chain
is charged per chunk.

When an Activity event omits mention entities, the plugin looks up the post to
verify that it targets this bot. If the budget cannot cover verification, the
mention is durably queued and verified after reset before any agent turn.
Unverified events and events for another bot do not advance this account's
cursor. If a mention entity provides only a username,
the plugin performs a $0.01 user lookup to verify the numeric recipient ID;
configured usernames alone cannot authorize a reply.

## Configuration reference

These fields work at `channels.x` and on individual account entries unless noted.

| Field                      | Default              | Purpose                                                                 |
| -------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `enabled`                  | `true`               | Enables the channel or account.                                         |
| `name`                     | Unset                | Optional account display name.                                          |
| `userId`                   | Required             | Numeric user ID of the bot account.                                     |
| `username`                 | Required             | Bot username without `@`.                                               |
| `clientId`                 | Required             | OAuth2 confidential application client ID.                              |
| `clientSecret`             | Required             | Application secret; supports SecretRef.                                 |
| `refreshToken`             | Required             | Bot's user-context OAuth2 refresh token; supports SecretRef.            |
| `bearerToken`              | Unset                | App-only Activity API bearer token; supports SecretRef.                 |
| `events.mode`              | `auto`               | `auto`, `stream`, or `poll`.                                            |
| `events.pollSeconds`       | `60`                 | Mentions polling interval, minimum 15 seconds.                          |
| `allowFrom`                | `[]`                 | Numeric author IDs, optionally prefixed with `x:`.                      |
| `groupPolicy`              | `allowlist`          | `allowlist`, `open`, or `disabled`.                                     |
| `dmPolicy`                 | `disabled`           | Only `disabled` is accepted.                                            |
| `threadContext.maxPosts`   | `50`                 | Maximum posts included in agent thread context, from 2 to 100.          |
| `costLimits.dailyUsd`      | `100`                | Maximum estimated X API spend per UTC day; `0` blocks paid calls.       |
| `costLimits.monthlyUsd`    | `1000`               | Maximum estimated X API spend per billing cycle; `0` blocks paid calls. |
| `costLimits.cycleStartDay` | `1`                  | UTC billing-cycle start day of the month, from 1 to 28.                 |
| `replySignature`           | `🤖 automated reply` | Added to the last reply chunk; up to 140 characters, empty disables it. |
| `accounts`                 | Unset                | Named account overrides; channel root only.                             |
| `defaultAccount`           | `default`            | Account selected when none is specified; channel root only.             |

## Troubleshooting

**No reply:** check the account's status, numeric bot ID, and effective allowlist.
The dropped-mention counter and last dropped author explain intentional silence.
There is no pairing flow. An empty allowlist blocks all authors under the
default policy.

**Streaming falls back:** the Activity API is unavailable for the app, or no
app-only bearer token was supplied in `auto` or `stream` mode. Polling remains operational;
check the reported event mode, stream connection/backoff, last event, and cursor.
Streaming also switches to polling when less than $0.50 remains in either
budget, and resumes after that budget resets.

**Budget paused:** check `spend` in channel status or the **X replies** page.
The status message gives the affected limit and reset time. Align
`costLimits.cycleStartDay` with your X billing cycle and increase the applicable
limit if needed. Changing limits does not erase recorded spend.

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
