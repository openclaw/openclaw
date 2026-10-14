---
name: slack-e2e
description: Test Slack with Convex-leased user OAuth or QA bots; check credentials, exercise owned messages, prove Gateway behavior, and distinguish API evidence from real Slack client interactions.
---

# Slack agent E2E

## Choose the proof

| Goal                                                      | Entry point                 | Boundary                                                           |
| --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| Check shared user OAuth                                   | Read-only command below     | User/workspace identity and channel history; no Gateway            |
| Exercise user-authored text                               | Same command with `--smoke` | Create, read, edit, delete, verify absence; no Gateway reply claim |
| Prove OpenClaw ingress, replies, tools, files, or restart | Existing QA Lab lane below  | Leased driver/SUT bots and an isolated Gateway                     |
| Prove real clicks, slash commands, or rendering           | Authorized Slack client     | Actual client observation, not reconstructed API data              |

Start from a source checkout with normal dependencies and an existing Convex
login. If needed, ask the operator to run `convex login` or the cached
`bunx --no-install convex login`. The broker provides the authorized pool;
agents do not need to copy Slack tokens. Login alone cannot supply a missing
pool credential or grant Slack permissions.

## User OAuth: no QA Lab run

```bash
node .agents/skills/slack-e2e/scripts/user-oauth-smoke.mjs
node .agents/skills/slack-e2e/scripts/user-oauth-smoke.mjs --smoke
```

The default is read-only **in Slack**; both modes acquire, heartbeat, and release
a Convex lease. `--smoke` creates one synthetic, unmentioned top-level message,
checks stored authorship, edits it, and deletes that exact message. Existing
workspace listeners can still observe it. Each command uses a new private
artifact directory and prints a safe result plus its path.

Read [user OAuth setup and recovery](user-oauth.md) for the pool payload,
permissions, result interpretation, and failure handling. This skill-owned
command reuses the existing lease helper; it changes no QA Lab code or release
lane and starts no Gateway or model. It does not add a user-driver option to
`qa slack`.

## Existing Gateway lane

Use the source-checkout QA Lab owner for Gateway proof, not a separate bot
runner. A run owns a leased driver/SUT pair, a temporary Gateway, native fixture
receipts, and private artifacts. The driver has no Socket Mode connection:
the SUT Gateway exclusively owns the app token and event delivery.

1. Use the existing Convex login above. No Slack tokens, broker secrets, model
   credentials, app creation, or scope grants belong in the command line.
2. Inspect the available scenarios and run readiness:

   ```bash
   pnpm openclaw qa slack --list-scenarios
   pnpm openclaw qa slack --doctor --output-dir .artifacts/qa-e2e/slack-doctor
   ```

   Doctor checks the **actual lease**: distinct bot identities in one workspace,
   both bots' channel access, the owned Gateway connection, and advertised OAuth
   scopes. Known missing scopes fail with their actor and exact names. Missing
   scope metadata means mutation capability is **unverified**, not granted.
   Missing optional file/reaction scopes do not block text-only flows; they
   block the affected native operations before dispatch. Doctor's full lifecycle
   capability verdict remains separate from mandatory connection readiness.
   A pool/login/permission failure is an owner prerequisite, not a reason to
   rotate credentials until one passes. Every subsequent run checks its own lease.

3. Run the native lifecycle recipe:

   ```bash
   pnpm openclaw qa slack \
     --scenario-file qa/scenarios/channels/slack-e2e-lifecycle.yaml \
     --output-dir .artifacts/qa-e2e/slack-lifecycle
   ```

   `--doctor` and `--scenario-file` default to Convex, the CI role, and
   `mock-openai`. This is real Slack/Gateway transport with a deterministic model.
   Explicit overrides remain available; ordinary curated `qa slack` defaults do
   not change. Use a unique output directory per run. Additional
   `--scenario-file` arguments select additional complete YAML scenarios.

4. Read the summary, evidence, and cleanup result before claiming success.
   Choose [feature recipes](features.md) for native operations or model-tool
   evidence, and [runtime recipes](runtime.md) for config/restart, custom flows,
   cancellation, artifacts, and recovery.

## Evidence boundary

| Surface                                                                                 | What automation proves                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Mention/quiet ingress, owned edits/deletes, reactions, upload, thread replies           | Fixture/API operations and explicit stored readback; not model tool calls            |
| Correlated SUT reply                                                                    | A stored reply from the leased SUT after ingress; mock or live model must be named   |
| Gateway debug-proxy capture                                                             | Slack accepted a Gateway API write; neither Socket Mode event delivery nor rendering |
| Block Kit, file IDs, reaction state                                                     | Stored structure/identity only                                                       |
| Human slash invocation, real button clicks, Agent View, visible rendering, human typing | Manual/Mantis client lane; bot/API evidence is insufficient                          |

For visual or human-interaction requests, use an authorized, logged-in Slack
client; the maintained Mantis workflow is in
`docs/concepts/qa-e2e-automation/operator-flow.md`. Check which surface it actually
captured: `--approval-checkpoints` renders API message data, not the Slack client.
A Slack sign-in screenshot is not proof of a workspace action.
Preserve inspected client screenshots alongside native evidence. Posting slash
text through the API is not a slash invocation; Gateway approval RPCs are not
button clicks. Do not infer typing from assistant status or start another Socket
Mode recorder with the SUT app token.

## Completion

Report scenario/model lane, stored native identities or safe counts, artifact
paths, cleanup outcome, missing permissions, and any manual-only gap. Keep raw
Gateway capture, channel IDs, messages, media, and lease material private; publish
only sanitized proof. A successful API response with failed stored readback, an
uncertain send, or failed cleanup is not an end-to-end pass.
