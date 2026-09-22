---
name: discord-e2e
description: "Prove OpenClaw Discord behavior with leased QA bots: native guild messages, files, threads, reactions, Gateway replies, streaming revisions, deletion, and typing. Use for Discord live feature or runtime debugging; user interactions require a manual client."
---

# Discord E2E

Run the repository's QA Lab against real Discord with a leased driver bot and a
separate leased SUT bot. QA Lab owns the lease, temporary Gateway, provider,
cancellation, and cleanup. This skill adds no standalone runner.

## 1. Choose the evidence

Read [feature recipes](features.md) for the changed behavior. Native fixture
calls prove Discord API operations, **not** that a model invoked a tool. A SUT
round trip additionally proves Gateway ingress and visible delivery. Model-tool
claims also require the tool trace and provider request evidence.

Slash commands, user component clicks, modals, ephemeral interactions, and bot
DMs are **manual-client-only**. A bot posting `/status` sends text, not a slash
interaction. Use bot tokens from the lease only; never user tokens or self-bots.

## 2. Prepare and check the current lease

Use the dependency-ready OpenClaw checkout under test. The setup prerequisite is
an existing authenticated Convex CLI with access to the published QA broker.
QA Lab discovers the repository's broker binding and CI credential in memory;
you do not need to copy bot tokens, guild IDs, or broker secrets. If authentication
is absent, have the operator run `convex login` (or the already cached
`bunx --no-install convex login`) once. Do not install a CLI or log in on the
operator's behalf. Network/permission errors are not evidence that another
login is needed.

```bash
pnpm openclaw qa discord --list-scenarios
pnpm openclaw qa discord --doctor \
  --output-dir .artifacts/qa-e2e/discord-doctor
```

Require a passing doctor. It sends no fixture messages; it checks the leased
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

Inspect `qa-suite-summary.json`, `qa-suite-report.md`, the Gateway/provider
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
