---
summary: "How to pair OpenClaw with Gatefile when you want review, approval, and controlled apply for agent side effects"
read_when:
  - You want a governed review/approve/apply boundary around agent-generated file or command changes
  - You want signed approvals or PR-native review outside OpenClaw core
  - You are deciding whether to keep side-effect governance inside OpenClaw or in a separate tool
sidebarTitle: "Gatefile"
title: "Using Gatefile with OpenClaw"
---

# Using Gatefile with OpenClaw

[Gatefile](https://github.com/StephenBickel/gatefile) is an optional external CLI that adds a
review and approval boundary around AI-generated side effects.

Use it when you want to keep **OpenClaw as the agent runtime** while adding an explicit
**inspect → verify → approve → apply** workflow for file changes and shell commands.

OpenClaw and Gatefile solve different layers:

- **OpenClaw**: agent runtime, channels, tools, sessions, memory, routing, subagents.
- **Gatefile**: governed side-effect execution, signed approvals, PR review surfaces,
  receipts, rollback metadata, and controlled apply.

Gatefile is **not bundled with OpenClaw** and is **not required** for normal OpenClaw usage.
This page is for teams that want a stricter approval boundary around agent output.

## When Gatefile is a good fit

Reach for Gatefile when you need one or more of these:

- A human or trusted signer must approve a plan **before** side effects happen.
- You want machine-readable review artifacts for CI, PR comments, or policy checks.
- You want a dry-run preview before writes or command execution.
- You want signed approvals and trusted-signer enforcement in CI.
- You want apply receipts and file-level rollback metadata for governed changes.

If you only need a strong agent with normal tool approvals, OpenClaw on its own is often enough.

## Basic flow

A common pattern is:

1. Use OpenClaw to produce a Gatefile draft or plan artifact.
2. Review it with Gatefile.
3. Approve it.
4. Apply it only after verification is ready.

Example:

```bash
# Optional: install Gatefile
npm install -g gatefile

# 1) Create a plan from a draft emitted by your agent workflow
gatefile create-plan --from draft.json --out .plan/plan.json

# 2) Inspect + verify
gatefile inspect-plan .plan/plan.json
gatefile verify-plan .plan/plan.json

# 3) Optional dry-run
gatefile apply-plan .plan/plan.json --dry-run --human

# 4) Approve
gatefile approve-plan .plan/plan.json --by steve

# 5) Execute
gatefile apply-plan .plan/plan.json --yes --human
```

<Note>
See the Gatefile repo for the current release status, examples, and advanced flows such as signed
approvals and PR-native review.
</Note>

## Recommended boundary

The cleanest split is:

- Let **OpenClaw** decide _what_ to do.
- Let **Gatefile** decide _whether and when those side effects are allowed to happen_.

That keeps OpenClaw focused on agent runtime concerns while making review and execution policy
explicit in a separate artifact.

## PR-native review

Gatefile is especially useful when OpenClaw is part of a GitHub workflow:

- generate `inspect-plan --json`
- generate `verify-plan` output
- generate `apply-plan --dry-run` output
- render a PR comment
- require approval/signer trust before execution

This gives reviewers a stable artifact to inspect instead of relying only on chat logs or raw agent output.

## Signed approvals

Gatefile supports optional signed approvals and trusted-signer policy.
That is useful when you want:

- CI to reject unsigned approvals
- CI to reject untrusted signers
- explicit signer identity in PR review flows
- a stronger trust boundary than “someone edited the file”

## Fork-safe review flows

For same-repo PRs, Gatefile can sign the plan on the branch.
For fork PRs, the safer pattern is artifact handoff:

1. PR workflow uploads the unsigned plan and reports.
2. A trusted signing workflow downloads that artifact.
3. It signs and verifies a copy.
4. It publishes the signed artifact for downstream gates.

That avoids pushing from a privileged signing workflow back into an untrusted fork branch.

## Limits to understand

Gatefile is intentionally not a replacement for OpenClaw, CI, or a full policy engine.
Current tradeoffs vary by Gatefile release, but in general you should assume:

- command rollback is limited compared with file rollback
- trust policy is repo-local and explicit
- signing proves cryptographic identity, not organizational authorization by itself
- the governed boundary is only as strong as the workflow that actually enforces it

## See also

- [Multi-Agent Routing](/concepts/multi-agent)
- [Approvals](/cli/approvals)
- [Hooks](/cli/hooks)
- [Testing](/reference/test)
- Gatefile repo: <https://github.com/StephenBickel/gatefile>
- Gatefile package: <https://www.npmjs.com/package/gatefile>
