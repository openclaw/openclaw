# Discord bot API readiness

Use this check to verify the leased bot pair without starting QA Lab. It reuses
the shared Convex lease and bounded HTTP response owners. The existing
[channelE2e lifecycle](features.md) remains the owner for message creation,
edits, deletion, reactions, files, threads, and fixture cleanup.

## Run

From a dependency-ready source checkout with an authorized Convex login:

```bash
node .agents/skills/discord-e2e/scripts/bot-readiness.mjs
```

The command only reads Discord. It still acquires, renews, and releases a
`kind=discord` lease. No token flags, broker secrets, or copied credentials are
needed. Login does not create a missing pool or grant Discord permissions.

The existing pool payload supplies `guildId`, `channelId`, `driverBotToken`,
`sutBotToken`, and `sutApplicationId`. Readiness requires two distinct official
bot accounts, the exact SUT application identity, a guild text channel in the
pinned guild, and history access for both bots. It rejects a DM, thread, or
foreign channel. Tokens stay in memory and are sent only as `Bot` authorization
to Discord's API; redirects and arbitrary destinations are not accepted.

Use `--output-dir` for a **new** private directory. Existing directories are
refused rather than overwriting earlier results. The default creates a unique
directory under `.artifacts/skill-e2e/`.

## What a pass means

View Channel and Read Message History are needed for the reads. The command
proves identity and REST access, **not** write permissions, Gateway intents,
event delivery, SUT replies, model tool use, or client rendering. It does not
calculate a competing permission matrix: current Discord responses decide this
limited check; the existing QA Lab doctor checks the broader lifecycle's
effective permissions and live Gateway readiness.

Message Content is a separate privileged Gateway intent. A successful history
request, especially an empty channel, does not prove that the bot can observe
SUT message content. Admin status does not replace that intent or enable
unsupported API routes. Continue with the existing QA Lab doctor and lifecycle
for product evidence; use a manual client for human interactions.

A pass requires `ok: true` and `leaseReleased: true`. Each run writes a private
`result.json` with check results, leased identities, failed phase, and release
status. It contains no tokens or channel history. The directory is mode `0700`
and the result is `0600`. Stdout prints safe checks, the failed phase, release
status, and the artifact path; sanitize local paths before public sharing.

## Failure and release

| Failure                                         | Action                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Convex discovery, authentication, or empty pool | Ask the broker owner to restore access; do not cycle credentials to find a pass |
| Identity mismatch or wrong channel kind/guild   | Repair the pool's coupled destination and identities                            |
| HTTP 401                                        | Pool owner checks the bot credential; never substitute a user token             |
| HTTP 403, code 50001 or 50013                   | Check the named bot's membership and effective channel read permissions         |
| HTTP 429                                        | Respect the rate limit; this run fails without automatic request retries        |
| Lease loss or interruption                      | Stop requests; report failure and the recorded release outcome                  |
| Lease release unconfirmed                       | Give the private credential ID and result to the pool owner for reconciliation  |

SIGINT/SIGTERM and lease loss abort in-flight reads and stop new requests.
Requests have a 45-second timeout and bounded response bodies. The shared lease
owner keeps the heartbeat until release; `finally` releases on success or
failure. A hard kill cannot guarantee release or result capture. No Discord
objects are created, so there is no message cleanup or mutation-recovery path.

Preserve failed results. Do not grant permissions or rotate tokens to manufacture
a pass. A released readiness result never qualifies a later run's lease.

Discord references: [bot-account policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots),
[permissions](https://discord.com/developers/docs/topics/permissions),
[rate limits](https://discord.com/developers/docs/topics/rate-limits).
