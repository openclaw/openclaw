---
summary: "Self-learning modes and the skills.workshop approval, autonomy, and size settings"
title: "Self-learning and approval settings"
read_when:
  - You are configuring Skill Workshop approval, autonomy, or limits
  - You want to understand where self-learning proposals are reviewed
  - You are scanning past sessions from the Control UI
---

## Self-learning

After substantial work, a detached background review can turn corrections and
successful procedures into reusable Workshop skills; see
[Self-learning](/tools/self-learning). Set `skills.workshop.autonomous.mode` to
`propose` to create pending proposals, or to `auto` to maintain complete skills
with normal agent tools. The Control UI Workshop tab shows
whether self-learning is on; use the config setting to choose all three modes.

### Scan past sessions

The Control UI can review older work without enabling autonomous self-learning.
Open **Plugins → Workshop** and select **Learn from past conversations**. A normal
session opens with the mining instructions, using the selected agent's configured
model, permitted tools, existing skills, and accessible conversation history.

The agent decides what to read and whether the evidence warrants a skill change.
It follows the current Workshop mode: `auto` permits direct improvements and
`propose` leaves suggestions for approval. No separate scanner selects transcripts
or limits the run to a fixed number of conversations or proposals.

Watch, steer, or stop the work in chat. The session keeps its instructions and
outcome instead of separate coverage counters. A manual request does not change
the self-learning setting. Normal session capacity, permissions, provider pricing,
and data-handling terms apply.

In `propose` and `auto` modes, OpenClaw can review one finished substantial turn
after the agent system becomes idle. It records the finished turn's boundary and
reads that turn's model context asynchronously with the same provider and model.
Review transcript and session metadata stay detached from foreground work.
In `propose` mode, only `skill_workshop` executes and the reviewer can stage one
pending mutation. In `auto` mode, ordinary file tools can inspect, edit, and
verify several connected files in the Workshop directory. The review inherits
source permissions and shell approvals. Its `process` tool cannot control
foreground jobs; the Workshop file root is not a shell sandbox.
A failed review is recorded after one attempt; completed direct edits remain.

See [Self-learning](/tools/self-learning) for enablement, eligibility, privacy and cost details,
the proposal threshold, and troubleshooting.

## Approval and autonomy

```json5
{
  skills: {
    workshop: {
      autonomous: {
        mode: "auto",
      },
      approvalPolicy: "auto",
      maxPending: 50,
      maxSkillBytes: 40000,
    },
  },
}
```

| Setting           | Default  | Effect                                                                                                                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autonomous.mode` | `"auto"` | `"off"` disables autonomous capture, `"propose"` creates pending proposals, and `"auto"` enables direct per-turn and weekly Workshop maintenance.                   |
| `approvalPolicy`  | `"auto"` | `"auto"` skips an additional prompt for agent-initiated `apply`, `reject`, or `quarantine` (the agent still has to call the action). `"pending"` requires approval. |
| `maxPending`      | `50`     | Caps pending and quarantined proposals per agent (1-200).                                                                                                           |
| `maxSkillBytes`   | `40000`  | Caps proposal body size in bytes (1024-200000). Autonomous proposals also have a 10,000-character cap; direct maintenance does not use proposal limits.             |

The selected model reviews retained evidence before deciding whether a durable
procedure needs an update. Foreground work does not wait for that review. It
starts only when the foreground runtime reports its resolved model and actual
`skill_workshop` availability; restrictive or unknown tool policy fails closed.

In `auto` mode, the reviewer uses the same direct-maintenance guidance as weekly
review. File tools stay rooted at Workshop; shell commands retain the source
session's execution policy. Source deletion, replacement, or permission changes
invalidate retained review authority. Direct maintenance does not run a post-turn
proposal scanner or create rollback snapshots. Use backups for unwanted edits.

In `propose` mode, the reviewer can read or prepare an exact span before staging
one pending mutation. Existing-skill proposals retain read receipts, content-hash
binding, size validation, and normal apply-time scanning and rollback metadata.
Immediate foreground repair also retains the normal proposal apply path in
`auto` mode; it is separate from direct background maintenance.

See [Self-learning](/tools/self-learning) for the complete autonomous review behavior and safety
model.

Proposal descriptions are always capped at 160 bytes, independent of
`maxSkillBytes`.
