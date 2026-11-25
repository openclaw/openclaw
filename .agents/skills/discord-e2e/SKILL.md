---
name: discord-e2e
description: "Test Discord with Convex-leased QA bots: check credentials without a Gateway, exercise owned messages, or prove OpenClaw replies, files, threads, reactions, streaming, and typing. Distinguish API and Gateway evidence from manual user interactions."
---

# Discord E2E

Choose the smallest boundary that proves the requested behavior:

| Goal                                  | Entry point                      | What it proves                                                            |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| Check the shared bot pair and channel | Read-only command below          | Bot identities, pinned SUT, guild text channel, and history access        |
| Exercise bot-authored mutations       | Existing `channelE2e` lifecycle  | Owned messages, reactions, files, threads, and cleanup                    |
| Prove OpenClaw behavior               | Existing QA Lab flow             | Real Discord events, an isolated SUT Gateway, and the selected model lane |
| Prove human interactions or rendering | Authorized manual Discord client | Actual user action or inspected client capture                            |

The API probe starts no Gateway, event recorder, or model. QA Lab remains the
owner for product E2E: it controls its lease, temporary Gateway, provider,
cancellation, and cleanup. Neither path changes app permissions or provisions
credentials.

## 1. Choose the evidence

Read [feature recipes](features.md) for the changed behavior. Native fixture
calls prove Discord API operations, **not** that a model invoked a tool. A SUT
round trip additionally proves Gateway ingress and a stored public reply. Model-tool
claims also require the tool trace and provider request evidence.

Human slash commands, component clicks, modals, ephemeral interactions, and
human-to-bot DMs need an authorized manual client. A bot posting `/status` sends
text, not a slash interaction. Use official bot tokens from the lease only.
Discord [prohibits user-token/self-bot automation](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots);
Slack's user OAuth route has no equivalent here.

## 2. Prepare and check the current lease

Use the dependency-ready OpenClaw checkout under test. The setup prerequisite is
an existing authenticated Convex CLI with access to the published QA broker.
The existing shared lease helper discovers the repository's broker binding and
CI credential in memory; you do not need to copy bot tokens, guild IDs, or broker secrets. If authentication
is absent, have the operator run `convex login` (or the already cached
`bunx --no-install convex login`) once. Do not install a CLI or log in on the
operator's behalf. Network/permission errors are not evidence that another
login is needed.

For a fast check without QA Lab:

```bash
node .agents/skills/discord-e2e/scripts/bot-readiness.mjs
```

The check is read-only **in Discord**, but it acquires, renews, and releases a
Convex lease. It creates no Discord objects and has no mutation mode. Read
[bot API readiness](bot-api.md) for the payload, permission limits, private
result, and failure handling.

This probe does not verify Gateway intents, event delivery, model behavior, or
all native fixture permissions. For an OpenClaw claim, continue with QA Lab:

```bash
pnpm openclaw qa discord --list-scenarios
pnpm openclaw qa discord --doctor \
  --output-dir .artifacts/qa-e2e/discord-doctor
```

Require a passing QA Lab doctor for this lane. It sends no fixture messages; it checks the leased
identities, guild text channel, effective permissions, driver Gateway intents,
and connected SUT Gateway. Every scenario repeats readiness on its own lease;
a released doctor's result never qualifies a later run.

`--doctor` and `--scenario-file` default to Convex, CI role, and `mock-openai`.
Existing explicit credential/provider flags still work; ordinary curated
`qa discord` defaults remain unchanged. Preprovisioned private broker environment
variables are an alternative to discovery, not a prerequisite.

## 3. Run one scoped proof

For a native lifecycle plus real Gateway reply:

```bash
pnpm openclaw qa discord \
  --scenario-file qa/scenarios/channels/discord-e2e-lifecycle.yaml \
  --output-dir .artifacts/qa-e2e/discord-lifecycle
```

For a changed feature, adapt that YAML using [feature recipes](features.md).
`--scenario-file` is repeatable and uses the existing QA flow schema. Set
`retryCount: 0` for native write scenarios. Use a new output directory for each
proof. These examples are opt-in, not additions to the curated default suite.

Read [runtime and recovery](runtime.md) when changing config, restarting the SUT,
choosing a real provider, diagnosing cancellation, or reconciling failed cleanup.

## 4. Judge and report

For the API probe, require `status: ready` and `leaseReleased: true`.
An empty history list is `inconclusive` (exit 2): it can mean an empty channel
or missing Read Message History permission. Use QA Lab doctor to distinguish
those cases; do not call either one a proven permission failure.
Report a ready result as bot identity and observed read-access proof, not
mutation or Gateway E2E. Private `result.json` contains leased identities and
check statuses, not tokens or history.

For QA Lab, inspect `qa-suite-summary.json`, `qa-suite-report.md`, the Gateway/provider
artifacts, and each private `discord-e2e-*/events.ndjson` under the output directory.
Join native receipts to recorder rows by message ID; use `actor: sut`, channel,
sequence, and trigger correlation for SUT claims. A marker alone does not prove
edits, reactions, typing, deletion, formatting, or a model tool call. Event logs
are not visual proof; visual claims need an actual Discord client screenshot.

Completion requires the requested evidence and successful owned cleanup after
Gateway stop, before lease release. Existing permissions decide whether owned
threads are **deleted** or **archived**; report the recorded disposition, never
call archival deletion. Preserve private evidence on failure. Report the sanitized
command, exact revision, claim, relevant evidence, manual-only gaps, and cleanup
outcome. Redact identities, unrelated content, private paths, and credentials
before sharing artifacts.
