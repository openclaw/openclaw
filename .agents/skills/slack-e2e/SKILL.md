---
name: slack-e2e
description: Prove OpenClaw Slack ingress, Gateway replies, native message actions, files, or runtime/config changes using Convex-leased QA bots; route human interactions and visual proof to the manual client lane.
---

# Slack agent E2E

Use the source-checkout QA Lab owner, not a separate bot runner. A run owns a
leased driver/SUT pair, a temporary Gateway, native fixture receipts, and private
artifacts. The driver has no Socket Mode connection: the SUT Gateway exclusively
owns the app token and event delivery.

## Run

1. Start from the OpenClaw checkout with its normal dependencies installed. Use
   the existing Convex login; if absent, ask the operator to run
   `convex login` or the already cached `bunx --no-install convex login`. QA discovers the
   authorized broker from that login. No Slack tokens, broker secrets, model
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

For visual or human-interaction requests, use the maintained Mantis Slack client
workflow in `docs/concepts/qa-e2e-automation/operator-flow.md`. Preserve inspected
screenshots/checkpoints alongside native evidence. Do not post slash-command text
as a bot and call it a human invocation, synthesize a click, infer typing from
assistant status, or start another Socket Mode recorder with the SUT app token.

## Completion

Report scenario/model lane, stored native identities or safe counts, artifact
paths, cleanup outcome, missing permissions, and any manual-only gap. Keep raw
Gateway capture, channel IDs, messages, media, and lease material private; publish
only sanitized proof. A successful API response with failed stored readback, an
uncertain send, or failed cleanup is not an end-to-end pass.
