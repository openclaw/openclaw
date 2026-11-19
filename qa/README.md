# QA Scenarios

Seed QA assets for the private `qa-lab` extension.

Files:

- `scenarios/index.yaml` - canonical QA scenario pack, kickoff mission, and operator identity.
- `scenarios/<theme>/*.yaml` - one runnable scenario per YAML file.
- `frontier-harness-plan.md` - big-model bakeoff and tuning loop for harness work.
- `convex-credential-broker/` - standalone Convex v1 lease broker for pooled live credentials.

Key workflow:

- `qa suite` is the executable frontier subset / regression loop.
- `qa manual` is the scoped personality and style check after the executable subset is green.
- `qa coverage` prints the scenario coverage inventory from scenario YAML.

Operator workflows:

- Use the `openclaw-qa-testing` skill for QA Lab live lanes, Convex credential
  pool operations, and WhatsApp live credential setup/replacement.

Keep this folder in git. Add new scenarios here before wiring them into automation.

QA-channel flows that assert final replies use `waitForCompletedQaReply` with the
message returned by `sendInbound`. It waits for the channel's processing
acknowledgment before reading the retained reply. QA-channel reset also waits for
pending inbound turns before clearing observations.

Reply-shape scenarios use `transport.waitForCompletedReply` with the inbound
message and Gateway client. For Crabline Discord, the adapter waits for an
observed delivery and the channel run queue to become idle. Its local API relay
keeps REST, Gateway discovery, and resumed WebSockets on the same origin. It
rewrites only Gateway discovery `url`, READY `resume_gateway_url`, and message
attachment `url`/`proxy_url` (including referenced messages). Message content,
embeds, and attachment descriptions pass through unchanged. It records the
message ID from the final send response, then reads that exact native
message before checking its text, destination, or quote relation. A deleted final
fails explicitly; a retained preview cannot replace it, and edits are judged from
the retained final. QA-channel uses its processing acknowledgment instead.
Adapters without a completion boundary fail explicitly rather than falling back
to the first matching outbound observation.

Generated-media scenarios count attachment deliveries separately from text
progress and check the saved bytes plus the persisted completion reply. Compare
that reply through the production tool-media selection and outbound payload plan:
persisted assistant text can retain generated-attachment Markdown that delivery
consumes. The private `qa-runtime` facade exposes the production media owner for
this comparison; transcript collection preserves the stored text.

## Confined repository checkpoint commands

`scripts/qa/repository-checkpoint-admission.ts` adapts the product-owned checkpoint
and publication command planners to the final campaign Git launch boundary. It executes only the
canonical bare checkpoint initialization, checkpoint Git-directory query, and
read-only publication config checks. All other commands exit 126 before spawning Git.

The launcher supplies freshly validated `checkpointRoot` (from the repository
workspace store), `nodeRoot` (from the current placement), `campaignRoot`, `cwd`,
`argv` (including `git`), and `env`. Paths must already exist, be canonical, and
remain inside the isolated campaign. The adapter does not discover sessions,
read state databases, authorize transport, or
manage checkpoint contents. Those responsibilities stay with their owners.
Do not turn a denied command into a generic Git write allowance.

Pass that JSON object on stdin
to `node --import ./scripts/tsx.mjs scripts/qa/repository-checkpoint-admission.ts`.
The launcher validates those current roots and exact canonical argv immediately
before spawning Git, sanitizes its environment, and forwards Git's output/status.
It uses the campaign launcher's PATH, not the requested command's PATH. Delegate
the process to this entry rather than treating its exit status as permission to
spawn Git again. Freeze it with the campaign tooling; preserve the enclosing
sandbox, freshly validated current-owner facts, and execution evidence. Historical
artifact shims that consumed the old Boolean interface must migrate to this
delegated launch; they are not maintained campaign entry points.

### Script checkout and artifact roots

The maintained test-file runner expands `${repoRoot}` to the selected checkout
and `${outputDir}` to the scenario's artifact directory. Script scenarios can
pass these as distinct arguments without embedding a campaign path or SHA.

## Holding a mock provider continuation

Private QA Lab flows using `mock-openai` can call
`env.mock.holdNextContinuation(sessionId, signal)` before starting a turn.
Pass the flow's existing `signal`; only one hold may be active per provider.
Await `hold.reached` for `{ cursor, sessionId, toolOutputCallId }`, then use
`hold.release()` to send the planned response or `hold.cancel()` to discard it.
The checkpoint identifies the next tool continuation for the exact transport
session, after request recording and before any response bytes. Compaction and
other sessions do not consume it. The cursor indexes the existing `/debug/requests`
log for this provider lifetime; it is not a durable Gateway run or receipt ID.
Collect those identities separately through their authoritative interfaces.

A hold captures one request. Reconnected/replacement requests proceed normally;
cancel the old hold in the scenario's `finally` after interrupting its caller.
Scenario cancellation and provider shutdown also settle pending holds. This
control is absent from model tools, Gateway RPC and ordinary plugin SDK exports.
