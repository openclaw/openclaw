# Discussion Draft: GPT-5.4 Computer Use Plugin For OpenClaw

## Title

Proposal: plugin-first `computer-use` integration for `openai/gpt-5.4`

## Body

I want to propose a plugin-first path for integrating GPT-5.4 computer use into
OpenClaw.

The design goal is not to push a full desktop automation runtime into core.
Instead, the goal is to create a narrow and reviewable seam:

- `GPT-5.4` handles UI understanding and next-step action decisions
- an external executor handles screenshots, mouse/keyboard execution,
  isolation, confirmation, and retries
- OpenClaw exposes the capability as an optional tool and orchestration layer

Why this shape:

- it matches OpenAI's current computer-use boundary
- it respects OpenClaw's plugin-first guidance for optional capability
- it keeps high-risk execution outside core until the pattern is validated

## Proposed MVP

First PR:

- add `extensions/computer-use`
- register an optional `computer-use` tool
- support four actions:
  - `start`
  - `status`
  - `confirm`
  - `cancel`
- forward requests to an external executor over HTTP
- default provider/model targeting to `openai/gpt-5.4`

The plugin would not directly execute host actions. It would only orchestrate
executor jobs.

## Why not core first

Because the difficult parts are OS/runtime-specific:

- screenshots
- permission handling
- window management
- retries and recovery
- confirmation gates
- isolation and audit

Those concerns seem better validated in a plugin and external executor first.

## Open questions for maintainers

1. Does plugin-first feel like the right landing zone for a first version?
2. Would maintainers prefer the first PR to stop at the plugin seam only,
   without shipping any reference executor?
3. Should `openai-codex/gpt-5.4` be part of the same interface later, or should
   the first version stay strictly on `openai/gpt-5.4` Responses?

## Current local draft

I have a local MVP scaffold with:

- proposal doc
- `extensions/computer-use`
- external executor contract

If this direction looks acceptable, I can split it into small PRs.
