---
title: "Skill, memory, and governance steward"
summary: "Repo-local review queue for skill, memory, and rule suggestions without canonical mutation"
read_when:
  - Reviewing skill, memory, or rule suggestions
  - Explaining pending governance decisions in status or phone replies
  - Preparing a packet before touching canonical skills, memory, AGENTS, or rules
---

# Skill, Memory, And Governance Steward

OpenClaw can prepare governance suggestions, but this steward is packet-first.
It does not write Codex memory, official OpenClaw memory, canonical skills,
skill-governance files, AGENTS files, or persistent rules.

## Local Queue

The repo-local queue for a current final-goal run should live at:

- `<project-root>/docs/status/skill-governance-decision-queue.md`

That file is a review surface, not an approval. It can be read by status or
phone summaries to explain what is queued and what is blocked.

## Classification

Every skill, memory, or rule suggestion must be classified before any action is
proposed.

| Class                    | Meaning                                                                                  | Allowed now                                                  | Blocked without confirmation                   |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `keep`                   | Keep the current artifact and do not propose a source change.                            | Record the reason in the queue.                              | None, because no mutation is requested.        |
| `later_metadata_cleanup` | The idea may clarify routing, trigger text, or docs later.                               | Record a small future packet or route-doc note.              | Editing canonical skill metadata directly.     |
| `packet_only`            | The idea touches durable memory, harness state, governance, or global rules.             | Produce a review packet with risk, rollback, and validation. | Applying the packet to canonical destinations. |
| `needs_user_decision`    | The next step changes policy, ownership, memory, skills, AGENTS, or persistent behavior. | Show one plain-language decision item.                       | Auto-approval or silent mutation.              |

## Packet Shape

A review packet should include:

- `title`: short human-readable proposal.
- `class`: one of `keep`, `later_metadata_cleanup`, `packet_only`, or
  `needs_user_decision`.
- `plain_status`: one sentence suitable for phone/status replies.
- `source`: where the suggestion came from.
- `proposed_destination`: exact canonical file or system, if any.
- `why`: reason the suggestion exists.
- `safe_alternative`: what OpenClaw can do locally instead.
- `blocked_action`: the mutation that must not happen yet.
- `approval_target`: exact user approval needed before mutation.
- `rollback`: how to undo the change if approved later.
- `validation`: command or check to run after an approved change.

## Phone And Status Text

Phone/status surfaces should lead with plain project language and only include
internal labels as secondary context.

Recommended wording:

- `现在没有要自动改的技能或记忆。OpenClaw 只整理了一个本地审阅队列。`
- `有 3 个治理问题需要你决定：是否合并记忆治理入口、是否先做研究技能路由表、是否沙盒测试一个低风险 metadata patch。`
- `涉及 Codex memory、OpenClaw memory、canonical skills、skill-governance、AGENTS 或 rules 的改动仍然锁住，需要你点名批准目标文件和改动内容。`

Avoid wording that implies the queue already has approval.

## Hard Boundary

The following actions remain hard-boundary actions:

- Codex memory write.
- Official OpenClaw memory write outside an explicitly approved official
  mechanism.
- Canonical `~/.codex/skills` mutation.
- Canonical skill-governance workspace mutation.
- AGENTS, global rule, or persistent rule mutation.
- Any daemon, cron, or monitor created to apply governance changes.

Allowed safe alternative: keep a repo-local packet or status queue under the
current OpenClaw docs/run artifacts.
