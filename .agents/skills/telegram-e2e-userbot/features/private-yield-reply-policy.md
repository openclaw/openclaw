# Private child settlement respects reply visibility

This opt-in live regression protects the configured reply mode after a private
child completes a yielded parent. It composes the real Telegram ingress,
Gateway, sessions_spawn (completionTarget: parent, context: isolated), child,
sessions_yield, requester-settle continuation, and outbound delivery. Only model
responses are deterministic. Delivery owners and policy resolution are not mocked.
The existing mocked requester-settle tests cannot catch a config policy lost
between announcement, agent-command preparation, and final payload delivery.

Prepare the exact candidate, Node, uv, and pinned TDLib before acquiring a
credential, as required by ../SKILL.md. Use a permitted isolated host, available
ports, and a new private proof directory outside the checkout. Run:

```sh
node .agents/skills/telegram-e2e-userbot/scripts/run-reply-policy-user-e2e.mjs \
  /private/proof/reply-policy 19879 19882
```

The matrix runs serially. Every cell invokes the canonical runner with fresh
state and its own credential/readiness/cleanup lifecycle. The full tool profile
keeps the parent’s actual message tool available; direct tool schemas are requested with
codeMode and toolSearch off, and each model decision validates the exposed schema.
No model call ordinal selects a branch. Tool results must parse as accepted and
match their real call IDs. Child identities, result receipt, and requester-settle
runtime IDs are correlated by an authoritative Gateway sessions RPC checkpoint,
independently of the mock provider. Missing composition proof is a fixture failure,
never a passing silence assertion.

| Cell                  | Configuration                         | Resumed parent                                        | Required Telegram result             |
| --------------------- | ------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| message-tool-ordinary | messages.visibleReplies: message_tool | Ordinary distinctive FINAL, no message call           | Zero final messages or edits         |
| automatic-ordinary    | messages.visibleReplies: automatic    | Same ordinary FINAL behavior                          | Exactly one final in the original DM |
| message-tool-send     | messages.visibleReplies: message_tool | Real message send to the leased source, then NO_REPLY | Exactly one final, no duplicate      |

The explicit-send control uses the public `message(..., final: false)` continuation
flag so the model can actually return `NO_REPLY` afterward. The default
`final: true` send legitimately terminates a tool-only turn in the production
message-tool terminal hook and must not be mistaken for a missing model follow-up.
This still sends a real persistent marked message; no transport is mocked.

An optional final positional cell name runs just that cell in a fresh proof
directory when a diagnosed fixture repair requires it; keep prior valid cells
and failed evidence rather than resending the entire matrix.

All cells forbid raw private child output and visible NO_REPLY. Each records
95 seconds and requires at least 60 seconds after the matched Gateway
`agent.wait` terminal receipt (or a later observed final), covering two
30-second recovery windows. The clock comes from the canonical recorder’s
`scenario.recorderReady.startedAtUnixMs`; Gateway teardown never counts. Missing
recorder or terminal timestamps fail even when no final is visible. Unexpected non-progress replies also fail the verdict. The report retains initial
and late model decisions, all bot event kinds, and sanitized Bot API timings.
A visible ordinary final in the negative cell **fails** the regression; do not
change its expected count or force the model to NO_REPLY to obtain green.

Exit 0 means all assertions and composition gates passed; 1 means a policy
assertion failed; 2 means the fixture or canonical lifecycle failed. A policy
failure still runs both independent controls. A fixture failure stops the matrix;
reconcile uncertain sends and cleanup before changing the fixture or running anew.
The verdict can be recomputed without acquiring credentials or resending:

```sh
node .agents/skills/telegram-e2e-userbot/scripts/run-reply-policy-user-e2e.mjs \
  --verify /private/proof/reply-policy/message-tool-ordinary message-tool-ordinary
```

Raw runner output, config, event files, and target.private.json contain private
identities. Keep them private under the proof lifecycle. Export only the sanitized
verdicts.json; inspect it before sharing. The script does not upload artifacts.
Canonical finalizer completion is required; additionally verify task-owned ports,
credential scratch, and any remote transport/compute cleanup at handoff.

This is a long live composition, intentionally outside per-PR unit CI. Measure
its wall time when run. No production seam or implementation fix is required.
