# OpenClaw Operator Harness MVP

This directory contains the supervised OpenClaw + Paperclip MVP harness described in
`docs/design/openclaw-paperclip-operator-harness.md`.

## What It Does

- OpenClaw provides the operator surface.
- Linear is the upstream backlog.
- Notion provides design/spec context.
- Paperclip stores the execution issue tree, assignments, run state, comments, and review evidence.
- Local `codex_local` Paperclip agents perform build, QA, and UX review work against the repo checkout.
- Browser validation and artifact capture are mandatory for implementation, review, and operator spot checks.

## Files

- `harness.config.json`: local harness config
- `harness.state.json`: provisioned Paperclip IDs and pause state
- `agents/*.md`: local builder and reviewer instructions
- `scripts/sync-pr.ts`: pushes the task branch and creates or updates the ticket PR
- `../.local/operator-harness/workspaces/<ticket>/<role>/`: per-ticket working clones and packet files

## Prerequisites

- Paperclip local instance reachable at the configured `paperclip.apiBase`
- `LINEAR_API_KEY` in the shell environment
- `NOTION_TOKEN`, `NOTION_API_KEY`, or `OPENCLAW_SKILL_NOTION_API_KEY` in the shell environment
- `agent-browser` installed and runnable from the shell
- OpenClaw repo dependencies installed with `pnpm install`

## Bootstrap

Run from the repo root:

```bash
pnpm openclaw operator bootstrap --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
```

This provisions or refreshes:

- the Paperclip company
- the Paperclip project and primary workspace
- local builder, QA, and UX agents

## Upstream Intake

The intake path is:

1. Create or identify a Linear issue in the configured team.
2. Put acceptance criteria in the Linear description.
3. Include the Notion page URL in the Linear description.

The harness fetches the linked Notion pages live during intake and normalizes that input into a structured Paperclip parent issue with:

- upstream ticket metadata
- acceptance criteria
- startup command
- healthcheck URL
- browser walkthrough
- required artifacts
- review roles
- linked Notion context

The configured storyboard hub baseline is always included for Moore Bass intake, so the harness has the live pilot corpus even when a Linear ticket links only a subset of the relevant pages.

## Operator Commands

```bash
pnpm openclaw operator status --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator start-ticket END-7 --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator next-ticket --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator request-review END-7 --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator spot-check END-7 --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator pause-all --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator resume-all --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
pnpm openclaw operator stop-all --config /Users/clankinbot/Code/openclaw/operator-harness/harness.config.json
```

## Execution Contract

`start-ticket` creates one parent Paperclip issue and one builder task. Each task packet includes:

- the dedicated working clone under `.local/operator-harness/workspaces/<ticket>/<role>/repo`
- the branch name for the ticket
- the startup command and healthcheck URL
- the browser walkthrough contract
- the evidence directory inside the repo clone
- the PR requirement and PR body path

Builders and reviewers must work inside their own ticket clone, not the main repo checkout.

## Evidence Contract

Each builder, reviewer, and spot-check artifact directory must contain:

- `before.png`
- `after.png`
- `annotated.png`
- `walkthrough.webm`
- `serve.log`
- `review.md`

Artifacts are committed inside the ticket branch under:

```text
/Users/clankinbot/Code/openclaw/.local/operator-harness/workspaces/<ticket-key>/<role>/repo/operator-harness/evidence/<ticket-key>/<role>/
```

This makes the screenshots directly embeddable in the PR body and keeps review evidence versioned with the branch being reviewed.

## Pull Requests

Each ticket requires a branch and a PR. The builder flow ends with:

```bash
node --import tsx /Users/clankinbot/Code/openclaw/operator-harness/scripts/sync-pr.ts \
  --task /Users/clankinbot/Code/openclaw/.local/operator-harness/workspaces/END-7/builder/.openclaw-operator/task-builder.json
```

That command:

- pushes the branch
- creates or updates the draft PR
- writes the PR URL back into the task packet
- embeds the committed screenshots directly in the PR body
- links the committed `walkthrough.webm` and `review.md`

Review cannot start until the builder PR exists.

## Verified Flow

The local harness has been verified with:

- live Linear + live Notion intake for Moore Bass tickets
- real `/pilot` and `/pilot/project` browser-routable UI surfaces on the OpenClaw UI dev server
- branch-backed task packets and PR synchronization wiring

`stop-all` cancels live runs and pauses the agent roster so the harness can be resumed cleanly with `resume-all`.
