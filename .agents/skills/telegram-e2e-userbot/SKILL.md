---
name: telegram-e2e-userbot
description: "Prove user-visible OpenClaw Telegram behavior on Telegram's Test Server with Convex-leased team credentials; drive real-user turns and record messages, edits, deletions, reactions, typing, or rich content."
metadata:
  short-description: Telegram E2E via real-user driver
  argument-hint: "<message-or-command?>"
---

# Telegram E2E (Userbot)

Prove the requested behavior as a dedicated Telegram Test Server user. TDLib
records edits, deletions, reactions, and typing that a second bot cannot observe.
For visual claims, also inspect actual Telegram client screenshots; a reconstructed
chat image or event log is not visual proof.

Each Convex credential contains one SUT bot and an independent authorization for
the QA user. The runner owns that lease through readiness, proof, and cleanup.
Pool creation, account authorization repair, and credential publication remain
owner-only. Reversible test-chat setup with the leased QA user is ordinary proof
work; preserve shared fixtures and other runs.

## 1. Prepare

Run from the OpenClaw checkout and ref under test, using its repository skill:

```bash
TELEGRAM_E2E_SKILL_DIR="${TELEGRAM_E2E_SKILL_DIR:-$PWD/.agents/skills/telegram-e2e-userbot}"
export TELEGRAM_E2E_SKILL_DIR
```

Verify `node`, `uv`, and a dependency-ready runtime for the exact ref before
leasing a credential. The runner uses built `dist/entry.js`; `--source-gateway`
uses the repository's development launcher when a dependency-ready source run
is appropriate. The live run must not implicitly install or build. Only the
`mock` backend needs `scripts/e2e/mock-openai-server.mjs`.

Convex access can come from either:

- An existing authenticated CLI with access to the published broker deployment.
  From `qa/convex-credential-broker`, discovery tries `convex`, then
  `bunx --no-install convex`, then `npx --offline --no --ignore-scripts convex`.
  Each launcher gets one 15-second `env --deployment <broker> get` lookup for
  the CI secret. The helper uses the repository's existing broker binding;
  no local `CONVEX_DEPLOYMENT`, project-selection file, or dashboard lookup is needed.
  The secret stays in process memory.
- Both `OPENCLAW_QA_CONVEX_SITE_URL` and `OPENCLAW_QA_CONVEX_SECRET_CI`, supplied
  privately to the doctor or runner process by the existing credential owner.

Check available launchers, existing authentication, and broker-project access
before declaring credentials missing. An authenticated launcher with
no CI variable needs broker configuration, not another login. Ask the user for
authentication only when no existing launcher can authenticate and the broker
pair is unavailable. Do not install or log in on the user's behalf. A timeout or
network failure is not evidence that credentials are missing.
Bun's `--no-install` missing-binary error means that launcher is unavailable;
discovery continues to the next installed launcher.

On shared hosts, select two unused ports and pass them explicitly; the runner
does not read port environment variables:

```bash
: "${TELEGRAM_GATEWAY_PORT:?set an unused Gateway port}"
: "${TELEGRAM_MOCK_PORT:?set an unused provider port}"
```

## 2. Select the proof

Read [the verification map](features/README.md), then only the recipe for the
behavior under test. Prefer a DM; use groups for group policy, mentions,
commands, topics, or reactions. A generic success turn does not prove formatting,
media, timing, or lifecycle behavior.

Extend the harness when its current actions or recorder fields cannot expose the
claim. Scenario `command` actions can inspect the leased TDLib state, private
credential file, Test Bot API proxy, and Gateway state. Use the
[runtime reference](features/runtime-reference.md) for timed scenarios, forums,
photo/reply actions, non-default backends, manual operation, or failed-run recovery.

## 3. Check readiness and run

The scenario checks its actual user, bot, transport, and selected chat on its own
lease before starting the Gateway. DMs do not depend on unrelated groups. Group
runs verify bot membership, privacy, and tester text permissions, preserving a
suitable selected group or preparing a run-owned one when needed. Readiness from
a released lease never qualifies a later run.

For a standalone diagnostic, use:

```bash
node "$TELEGRAM_E2E_SKILL_DIR/scripts/telegram-test-doctor.mjs"
```

Require `ok: true`. The doctor defaults to DM readiness; `--chat <target>` checks
a selected group. It releases its diagnostic lease and does not start product
proof. Preserve setup failures and repair their cause before trying again;
rotating unchanged credentials to hunt for a pass is not a repair.

Create a durable proof directory outside runner scratch:

```bash
TELEGRAM_E2E_PROOF_DIR="$(mktemp -d /tmp/telegram-e2e-proof.XXXXXX)"
node "$TELEGRAM_E2E_SKILL_DIR/scripts/run-mock-sut-user-e2e.mjs" \
  --gateway-port "$TELEGRAM_GATEWAY_PORT" --mock-port "$TELEGRAM_MOCK_PORT" \
  --dm --text 'Please answer with OPENCLAW_E2E_OK only.' \
  --record "$TELEGRAM_E2E_PROOF_DIR/events.ndjson" \
  --output "$TELEGRAM_E2E_PROOF_DIR/summary.json"
```

The runner owns the lease, proxy, fresh Gateway, provider, user actions, recorder,
and teardown. Recording captures facts and rejects probe assertions such as
`--expect` and `--any-sut-reply`. A send-confirmation timeout can follow an accepted
send: preserve observed events and reconcile them, rather than blindly resending.

## 4. Judge and clean up

Start at the sent action in `summary.json`; judge only later events from the
selected SUT. Use raw TDLib `messageId` within the same user's chat, not another
account's Bot API receipt, to connect edits and deletions. Require a provider
request when the path should reach the model; native commands may produce none.

Report the sanitized command, sent action, relevant timeline rows, provider
request count, and the claim those facts prove. Inspect `test-group.json` when
setup ran; fixture evidence is not message proof. Keep credentials, identities,
and private paths out of shared logs, screenshots, and reports.

Completion requires the claimed Telegram evidence, no runner-owned processes or
listeners, released lease, removed credential scratch, and readable proof files.
Cancellation or lease loss stops new work and joins owned consumers. Unconfirmed
cleanup is a failure: preserve the private recovery state and use the
[runtime recovery instructions](features/runtime-reference.md#retained-run-recovery).
Keep explicit proof directories until the review or reproduction no longer needs them.
