---
title: "Claw consent recovery proposal"
summary: "Proposed operator review for historical Claw agents blocked by stale consent"
read_when:
  - Reviewing recovery from historical Claw consent mismatches
  - Designing the Claw consent projection or Doctor diagnostics
---

# Claw consent recovery proposal

**Proposal only; requires approval before implementation.** The commands below
do not exist. This proposal addresses
[#178741](https://github.com/openclaw/openclaw/issues/178741) without accepting a
changed consent digest automatically or replacing the affected agent.

## Current gap

Historical Claw agents can stop running after a workspace relocation or model
change. The runtime rejects their stored consent digest, but there is no
supported way to review and renew that consent for the same agent.

The current CLI offers authoring, inspection, and Add. Control UI Add also
creates a new agent; its plugin and skill review does not renew historical agent
consent. The retained provenance readers have no corresponding consent writer.
The old update/remove schema definitions do not expose working Gateway methods.
See [Claw commands](/cli/claws) for the supported product surface.

The consent owner is `src/claws/tool-policy-runtime.ts`; its inputs come from
`src/claws/tool-policy-candidates.ts` and the shared-state provenance reader.
The original 2026.10.5 writer stored a whole-agent digest. Current candidates
include both that whole-agent variant and a projection excluding `model` and
`subagents`. Changing a model can therefore invalidate a historical whole-agent
receipt even though the new projection excludes models.

## Proposed operator flow

Add one recovery command, `openclaw claws consent <agent-id>`, for an existing
historical Claw agent. It reviews the configured agent, not a replacement package.
An optional `--dry-run` prints the same review without writing. Applying consent
requires an explicit interactive confirmation; neither Doctor repair, an agent
turn, nor an unattended update can approve it.

Show the agent ID, selected state directory, recorded and current workspace,
tool profile and explicit grants/denials, and effective sandbox policy. Show
changes against the last reviewed projection where available. Old records retain
only a digest and limited location metadata: label unknown prior tool/sandbox
values as unknown and show the complete current policy for review. A hash
mismatch cannot identify which fields changed.

Require a bounded, explicit tool allowlist. A legacy dynamic profile must be
configured with an explicit list before approval; recovery must not turn it into
an unbounded grant. Host restrictions remain in force. The command neither adds
plugins/skills nor approves their independent capability requests.

On confirmation, preserve the agent ID, sessions, workspace contents, and cron
references. Update only the consent record and reviewed workspace metadata; do
not move files, reinstall packages, create another agent, or delete resources.
The old package path remains historical provenance, not a write destination.

## Consent scope and receipts

Use one versioned consent projection at the existing candidate owner. Exclude
model choice and `subagents` from every accepted digest variant going forward;
retain workspace, tool policy, and sandbox policy. Remove whole-agent fallback
comparison when this recovery path ships. Historical whole-agent records that
cannot match the new projection require explicit review, never silent conversion.

Persist the approved projection with its version, previous and new digests,
agent ID, selected state identity, approval time, and approving operator origin.
Use the existing shared-state owner and transaction machinery; a scoped
machine-state receipt can avoid a new table. Keep receipt data limited to consent
inputs; never copy credentials or the entire config. Define any new retained
fields explicitly during implementation review.

The Claw consent owner owns the write. Local CLI application uses exclusive
offline custody; a future Control UI adapter must use the Gateway owner with
current administrator authority. Bind confirmation to the reviewed config,
workspace resolution, state identity, and existing receipt. Revalidate immediately
before committing; changed inputs require a fresh review. Timestamps, hashes,
and receipt possession do not replace live authority.

Back up the affected state before mutation. Commit the receipt and consent
metadata together, then invalidate the existing provenance cache through its
owner. A failed commit leaves old consent intact. Rollback restores the prior
receipt and metadata without touching agent resources; an uncertain outcome is
reconciled from the committed receipt before retrying.

## Refusal and Doctor routing

After the command exists, runtime refusal and Doctor must share the same
diagnostic: identify stale consent, show known changes, label unknown historical
fields honestly, and name `openclaw claws consent <agent-id>`. Doctor reports the
problem but never renews consent through `--fix` or `--yes`. A corrupt or unreadable
database remains a separate repair failure, not a consent prompt. Pending consent
is an update/Doctor warning; the affected agent stays blocked until review.

## Required proof before implementation is ready

- Relocate a historical 2026.10.5 fixture, change its model, and reproduce refusal
  through an isolated Gateway. Denying review preserves the refusal and all data.
- Approve the reviewed policy and prove the same agent can run, with sessions,
  workspace contents, and cron references preserved across restart and upgrade.
- Model/subagent changes do not invalidate the new receipt. Workspace, tools,
  or sandbox changes still require review, including changes during confirmation.
- Doctor and unattended updates cannot approve consent. Failed writes and rollback
  preserve the prior grant. Independent state directories cannot share receipts.

Run the focused consent and CLI regressions on Node and the pinned OpenClaw Bun
fork. This proposal changes no runtime behavior; implementation and its new CLI
surface remain pending approval.
