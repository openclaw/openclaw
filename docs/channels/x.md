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
a reply by default. Unknown authors are silently dropped unless you enable guest mode; they receive no
pairing prompt.

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

## Public work sessions

Set `channels.x.accounts.<accountId>.autoPublishWorkSessions: true` (or the
shared root default `channels.x.autoPublishWorkSessions`) to publish fresh,
isolated visible work sessions spawned directly by admitted maintainer mentions.
Guest mentions remain limited to hidden helpers and cannot publish work sessions.
This is **off by default**. It exposes that child's conversation to anonymous readers
at the same canonical `/chat` link; it does not change Team collaboration rights.
Only enable it for an agent whose work is intended to be public.

Publication requires a configured **app-only** `bearerToken`. Before admission,
the plugin looks up every post included in the supplied thread context using
application-only authentication and requires explicit `protected: false`
author metadata. Missing, edited, protected, withheld, or unavailable posts and
failed lookups deny automatic publication. A permalink or successful
user-context lookup is not proof of a public audience. Verification reads share
the account's X API budget; insufficient budget denies publication without
bypassing the cost limits.

The permission belongs only to that incoming invocation: it is not stored on
the X conversation, inherited by grandchildren, or accepted in model-authored
spawn arguments. Forks, private/draft sessions, incognito sessions, and existing
sessions cannot be automatically published. Changing the account configuration
or allowlist retires in-flight publication authority. The creation owner commits
the public grant with the child before its first turn, and the spawn receipt
reports `publicRead` only for the committed grant. Links without that receipt
are labeled as requiring sign-in. This lane requires the live in-process Gateway;
it does not downgrade to a transport that loses the invocation's authority.

Manual publication remains governed by the existing creator/administrator
sharing controls. No X identity is promoted to a Team profile or administrator.

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

`guests.enabled` controls admission outside the maintainer allowlist. The legacy
`groupPolicy: "open"` setting is unnecessary and cannot bypass the guest switch.
`groupPolicy: "disabled"` turns off all inbound turns. `dmPolicy` accepts only
`disabled`.

## Guest mode

Guest mode lets people outside the maintainer allowlist ask repository questions.
It defaults to off. After configuring the front-door agent below, use the
**Guest mode** switch on **X replies**, or run:

```bash
openclaw config set channels.x.guests.enabled true
openclaw config set channels.x.guests.enabled false
```

The config watcher reloads the X channel without restarting the Gateway. The UI
uses the administrator-only `x.guests.set` method and persists the same config.
For an explicitly configured account, the switch writes that account's override;
otherwise it writes `channels.x.guests.enabled`. Account overrides inherit the
other guest settings from the channel root.

Guests receive the core `read`, `ls`, `sessions_spawn`, `sessions_yield`, and
`subagents` tools, further restricted by the agent's normal policy. They can
start hidden helpers of the same agent. Helpers inherit the guest's restricted
tools and repository root; they cannot become visible work sessions or target
another agent. `sessions_yield` waits for helper completion, and `subagents`
lists, waits for, or cancels helpers.

Guests cannot edit files, run commands, browse or fetch the web, use memory,
send messages, or inspect unrelated sessions. The optional `guests.tools.allow`
can narrow the five default tools; an empty array disables all tools.
`guests.tools.deny` takes precedence. Neither setting can add stronger tools.

Hidden helpers require a host that advertises enforcement of these restrictions.
Older hosts keep the `read` and `ls` defaults, even when they report the same
OpenClaw version. The X replies settings page shows upgrade guidance when helper
support is missing. Explicitly selecting only helper tools on an older host
disables all guest tools; it does not restore the default read tools.

Each guest mention gets a separate channel session and the quoted X thread
context. It does not reuse a maintainer's conversation history, permission mode,
root directory, or selected skills. Maintainers keep their existing sessions,
tools, and work-session replies. Guest replies may cite documentation URLs, but
OpenClaw never appends a work-session link to a guest reply.

### Repository containment

Tool names alone do not confine filesystem reads. Configure the X front-door
agent's `cwd` and `workspace` to the OpenClaw clone and enable the core's
workspace-only file guard. The supported guest setup also disables selected
skills and Docker/remote sandbox mode: skill directories and sandbox mounts are
explicit read exceptions in core and can expose files outside that clone.
For example, add these fields to the agent selected by your X binding:

```json5 validate=false
{
  workspace: "/srv/openclaw",
  cwd: "/srv/openclaw",
  skills: [],
  sandbox: { mode: "off" },
  tools: { fs: { workspaceOnly: true } },
}
```

The effective filesystem setting is
`agents.entries.<agentId>.tools.fs.workspaceOnly`, falling back to
`tools.fs.workspaceOnly`. The X plugin refuses guests before thread expansion
when that setting is absent or false, skills are enabled, or sandbox mode is
active. Channel status reports the required correction as
`guestModeBlockedReason`; maintainer mentions continue normally.

Guest mode also requires a queue mode that cannot steer or interrupt an active
turn. Set the channel override before enabling guests:

```json5
{
  messages: { queue: { byChannel: { x: "followup" } } },
}
```

`collect` is also supported. Without a channel override, `messages.queue.mode`
must be `followup` or `collect`; the default `steer` and explicit `interrupt`
block guest admission before thread expansion. The **X replies** page shows
the required setting in its existing guest-readiness message. Changing the
queue mode back to either unsafe value blocks subsequent guest mentions.

Core owns path and symlink containment and rejects reads outside the session
root with `Path escapes sandbox root`. Keep guest channel sessions in their
initial permissions: do not grant full permission, widen their session root,
or attach external skills or skill-library pins through operator controls.
Those operator actions deliberately change core's filesystem authority. Guest
turns have no tools that can make those changes. Put maintainer work in their
normal work sessions when it needs a broader filesystem or skills.

### Limits and identity

The default limit is **5 mentions per guest author per UTC day**, independently
for each bot account. Set `guests.maxMentionsPerAuthorPerDay` from 0 to 1000;
0 admits no guests. Over-limit mentions are dropped silently before thread
expansion. Guest thread context defaults to **10 posts**, controlled by
`guests.threadContextMaxPosts`; maintainers retain `threadContext.maxPosts`.
The UI and channel status expose `guests.enabled`, `admittedToday`, and
`rateLimitedToday`. Admitted counts include reserved turns even when a later
thread lookup or model run fails; retries reuse their reservation.

Usage lives in bounded, worker-backed plugin state (`x.guest-usage`) for two
days. Capacity exhaustion pauses new guest admissions rather than evicting a
current author's quota. Recent rejected post IDs are retained to avoid counting
normal retries twice; unusually late retries after that bounded history can
increment the rate-limited statistic again. The ingress queue separately
suppresses completed event replay.

Guest turns incur the same X API and model costs as other turns. Thread reads
and each reply post are billed normally; a guest citation URL receives X's
higher URL-containing reply price. The author quota is not a dollar budget.

**Security:** the host determines the tier only from X's numeric `author_id`
against the effective union of configured and administrator-managed allowlist
entries. Handles, display names, post text, and model output never grant
maintainer access. Every agent-facing turn starts with a host-generated sender
line; all thread posts below it are quoted data. Removing a maintainer from the
allowlist makes subsequent mentions guests when guest mode is on.

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
checks that the post addresses the bot, and ignores blank keep-alives. Other
event types do not create inbound turns; delivered `post.*` events still count
toward the budget. It reconnects with backoff after a stalled or disconnected
stream.
Each connection runs a mentions backfill with the user token from the saved
cursor, then repeats it every `events.pollSeconds × 4`
(minimum 60 seconds, default 240 seconds) while streaming. This safety backfill
recovers mentions missed by the stream. Only completed backfill pages advance
the cursor, so newer stream events cannot hide older missed mentions. Post IDs
deduplicate stream and polling events.

After three consecutive unparseable mention events or malformed lines, the
plugin logs one warning and shows it in the channel status `message`. Blank
keep-alives and intentionally ignored event types do not count toward this
warning. It includes the event type and top-level keys, without post content.
The next parseable mention event clears the warning.

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

When a maintainer turn starts a visible work session, its first session URL is appended
to the reply unless the text already contains that URL. The canonical link is
publicly readable only when the creation receipt confirms publication; otherwise
it is labeled "Work session (sign-in required)." Both use X's URL-containing
reply price.

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
the plugin includes them to avoid underestimating spend, including expansions
returned with Activity events. All delivered
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

| Field                               | Default                 | Purpose                                                                           |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `enabled`                           | `true`                  | Enables the channel or account.                                                   |
| `name`                              | Unset                   | Optional account display name.                                                    |
| `userId`                            | Required                | Numeric user ID of the bot account.                                               |
| `username`                          | Required                | Bot username without `@`.                                                         |
| `clientId`                          | Required                | OAuth2 confidential application client ID.                                        |
| `clientSecret`                      | Required                | Application secret; supports SecretRef.                                           |
| `refreshToken`                      | Required                | Bot's user-context OAuth2 refresh token; supports SecretRef.                      |
| `bearerToken`                       | Unset                   | App-only bearer for Activity and public-context verification; supports SecretRef. |
| `autoPublishWorkSessions`           | `false`                 | Publish fresh visible work sessions for verified-public maintainer mentions.      |
| `events.mode`                       | `auto`                  | `auto`, `stream`, or `poll`.                                                      |
| `events.pollSeconds`                | `60`                    | Mentions polling interval, minimum 15 seconds.                                    |
| `allowFrom`                         | `[]`                    | Numeric author IDs, optionally prefixed with `x:`.                                |
| `groupPolicy`                       | `allowlist`             | `allowlist`, `open`, or `disabled`.                                               |
| `dmPolicy`                          | `disabled`              | Only `disabled` is accepted.                                                      |
| `threadContext.maxPosts`            | `50`                    | Maximum posts included in agent thread context, from 2 to 100.                    |
| `guests.enabled`                    | `false`                 | Enables repository-only answers for non-allowlisted authors.                      |
| `guests.maxMentionsPerAuthorPerDay` | `5`                     | Per-author, per-account UTC-day limit, from 0 to 1000.                            |
| `guests.threadContextMaxPosts`      | `10`                    | Guest thread context cap, from 2 to 100 posts.                                    |
| `guests.tools.allow`                | Host-supported defaults | Narrows the default guest tools; an empty array disables all tools.               |
| `guests.tools.deny`                 | `[]`                    | Further denies guest tools; deny wins.                                            |
| `costLimits.dailyUsd`               | `100`                   | Maximum estimated X API spend per UTC day; `0` blocks paid calls.                 |
| `costLimits.monthlyUsd`             | `1000`                  | Maximum estimated X API spend per billing cycle; `0` blocks paid calls.           |
| `costLimits.cycleStartDay`          | `1`                     | UTC billing-cycle start day of the month, from 1 to 28.                           |
| `replySignature`                    | `🤖 automated reply`    | Added to the last reply chunk; up to 140 characters, empty disables it.           |
| `accounts`                          | Unset                   | Named account overrides; channel root only.                                       |
| `defaultAccount`                    | `default`               | Account selected when none is specified; channel root only.                       |

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
