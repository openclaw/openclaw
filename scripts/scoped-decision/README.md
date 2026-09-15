# Try a scoped decision experiment

This development-only spike exercises a small part of the persistent-agent idea:
message + relevant activity state → candidate → host checks → exact
**authorization preview**. It does not implement the executive or settle the proposed
architecture, consistency boundary, memory layers, or transport.

## Run it

Use a trusted OpenClaw source checkout with its dependencies installed. From the
repository root:

```bash
node --import ./scripts/tsx.mjs scripts/scoped-decision/cli.ts
node --import ./scripts/tsx.mjs scripts/scoped-decision/cli.ts \
  --message 'Use B for campaign X.'
node --import ./scripts/tsx.mjs scripts/scoped-decision/cli.ts \
  --report /tmp/scoped-decision-experiment.json
```

The first command runs synthetic positive and adversarial cases. The second shows
one decision record, including its exact destination and payload. The third saves
a machine-readable report; choose a new path because existing files are not
replaced. No command above reads Gateway configuration, uses credentials, invokes
a model, changes an activity, or sends a message.

The demonstration host is a fixture, not your real account permissions. Use only
synthetic examples. The output is a test result: nothing is sent, reserved,
admitted, committed, or cancelled. Reports contain a nullable `preview`, not a
delivery receipt or a `sent` flag.

## What is being tested

The automatic path deliberately supports a tiny grammar: `Use A/B for <activity
label>.`, optionally prefixed with `Please`. The label must identify exactly one
of at most eight supplied activities. This spelling is an experimental control,
not a proposed product command or an automatic understanding of ordinary chat.

- The candidate has a closed, bounded JSON schema, validated through OpenClaw's
  public schema SDK. It can propose a direction and activity, not a destination,
  permission, arbitrary payload, or policy label.
- The host independently binds the exact instruction to an activity. A wrong but
  otherwise allowed activity is rejected. Brainstorming, quoted instructions,
  negation and unsupported wording cannot be made actionable by a positive model
  classification. A proposed directive outside the grammar needs clarification;
  the no-model baseline abstains when it cannot recognize an instruction.
- Decision authority and disclosure are separate. One current source-owned rule
  must permit the specific direction/activity/destination and recipient import.
  Missing or conflicting rules block the preview. These are supplied
  synthetic grants, not an implemented cross-Gateway policy system. The fixture
  host supplies both release and import permissions; no remote policy is queried.
- The output is a fixed direction-update payload using host-owned activity IDs.
  Conversation text, activity labels and private rationale are not copied into
  it. This does not establish safe release of arbitrary summaries or artifacts.
- The host is reread after awaited classification. Revoked grants and changed
  actor/source/destination bindings cannot use the earlier snapshot. This is a
  local current-state check, not an atomic distributed admission guarantee.
  Revoke→regrant during classification can produce a preview if the final state
  permits it. Replacing activities or policies with equivalent values under the
  same IDs cannot be distinguished from their original lifetimes. Rejecting those
  transitions would need an agreed revision/generation contract, not just matching
  IDs. `currentDirection` is classifier context, not a revision or an enforcement
  mechanism; the preview never changes it.
- A `Stop` request is reported as `stop-observed` without a classifier call. The spike
  does **not** claim to have interrupted or cancelled real work.

A clear, permitted command produces a preview without another confirmation. Late-turn
writeback, durable B retention, next-turn coherence, operation-level fencing and
replanning are not implemented here.

## What the numbers mean

The default routes are **explicit-command** (deterministic parser) and
**inline-candidate-replay** (hand-authored candidate, including deliberate errors).
Both invoke zero models. Their timings measure local code and replay, not model
inference or integration inside an existing turn. Identical or curated outputs
are not evidence that any model performs well.

Reports score raw classification and target/direction errors separately from
unsafe previews and missed authorized previews. Classifiers receive
only the message and relevant activity projection, never evaluation answers,
other candidates, permissions, routing addresses, or unrelated history.

Usage fields have `knownTotal`, `observedSamples`, and `totalSamples`. A zero known
sum with zero observed samples means **unmeasured**, not free. Missing usage and
physical provider request counts remain unknown; failed requests are not assumed
to be free. Classifier wall time and validation time do not overlap. Every route
leaves actual inline-model overhead unmeasured. No automatic replanning or retry
is introduced by the experiment.

## Optional separate-model adapter

[simple-completion.ts](./simple-completion.ts) exports
`createSimpleCompletionRoute`. It is not wired to the CLI or installed in a live
Gateway. A future authorized host caller supplies its existing `cfg`, bound
`agentId`, `useUtilityModel`, an exact approved `{provider, modelId}` selection,
`authorizeInput`, and `assertCurrent` callbacks. It can then pass the resulting
route to `runExperiment(fixtures, [route])` or `runCase`.

The adapter uses only the public
`openclaw/plugin-sdk/simple-completion-runtime` preparation/execution helpers.
It does not load configuration itself or accept raw credentials. Direct adapter
calls receive the same runtime validation and allowlisted projection as `runCase`:
at most 4096 message characters, eight distinct valid activity IDs, bounded labels,
and directions A/B. Extra fields are omitted. Invalid inputs fail before approval,
SDK preparation, or completion. A private snapshot of those projected fields is
used for all input approvals and prompt serialization, so caller mutation during
preparation cannot replace approved content.

Input approval is checked before preparation and again through the SDK's
current-authority callback before execution. `deadlineMs` (default 15000, range
1–60000) starts before SDK preparation and covers subsequent dispatch and result
use checks, not just inference. It requests a provider-dependent token limit and
passes the deadline's abort signal, with no tools. SDK preparation accepts no
abort signal: an overdue preparation cannot dispatch once it returns, but a
preparation that never resolves cannot be interrupted by this adapter. A provider
that ignores abort may also finish late; its output is discarded after the
deadline, while observed usage is retained. This is **not** an end-to-end latency
bound, and renaming the option does not remove that SDK limitation.

`useUtilityModel: true` asks OpenClaw to resolve its configured/provider-declared
utility model. This is not a bundled, free local model. Resolution may select the
primary model when utility routing is unavailable or disabled; an unexpected
selection is rejected **before completion**, not silently relabeled as utility.
Host configuration and any model-auth discovery remain owned by OpenClaw.

These calls are **separate direct-provider completions**, not native Codex turns.
They report their logical completion attempts and returned token counts, but do
not invent physical retry counts. They must only receive synthetic input on a
host-approved processing route. A denied/error result does not include raw
provider errors, auth, configuration, or model identifiers.

OpenClaw also provides `api.runtime.llm.complete` with
`execution.mode = "isolated-agent-runtime"` for supported native runtimes. That is
still a separate fresh context; the inspected API has no automatic utility-model
selector. This spike does not bypass that boundary or claim a native same-turn
comparison. A real inline-versus-utility experiment still needs actual host-turn
integration and whole-workflow measurements, including replanning.

## Verify

```bash
node scripts/run-vitest.mjs test/scripts/scoped-decision.test.ts \
  test/scripts/scoped-decision-completion.test.ts
```

Tests use the same caller-facing functions as the CLI. The adapter tests replace
the public completion SDK with controlled responses, including composition through
`runCase`; they are not live provider or native-runtime validation. Synthetic canaries prove only these supported
fixture paths, not general company-data isolation.

## Source basis

Built against OpenClaw `59f57f3cc5fa4beaba0d2f08bcc7e5ed3d947b3e`.
Relevant existing owners:

- [Public prepared completion SDK](../../src/plugin-sdk/simple-completion-runtime.ts)
- [Utility selection](../../src/agents/utility-model.ts)
- [Direct prepared execution](../../src/agents/simple-completion-execution.ts)
- [Native-aware plugin completion](../../docs/plugins/sdk-runtime/models.md)
- [Public JSON schema validation](../../src/plugin-sdk/json-schema-runtime.ts)

This is unpublished experimental code, not maintainer-approved architecture or
proof that OpenClaw already implements the wider proposal. There are no new
configuration keys, runtime stores, protocol changes, external dependencies, or
production hooks.
